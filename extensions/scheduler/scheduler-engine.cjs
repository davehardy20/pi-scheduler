// Scheduling engine: the timer + rearm + lease-recovery + claim lifecycle for
// the scheduler extension. Extracted from index.ts so the orchestration
// invariants (bounded non-zero rearm, lease-expiry recovery, generation/shutdown
// gating, scope-abandon) live behind one testable interface instead of an
// untestable closure sharing seven pieces of mutable state.
//
// This module is PI-FREE: it never imports ExtensionAPI or touches
// ExtensionContext. The store, clock, lease-sizing, normalization, and the
// settle half (run = runClaimedExecution) are injected. execute/isInScope/
// reporting/UI-refresh are bound from index.ts so Pi-coupled concerns stay out.
//
// Invariants preserved verbatim from the original index.ts implementation:
//   * only the claim owner (runnerId + claimToken) completes; a reclaimed
//     expired-lease task is ABANDONED to pending, never executed by the
//     reclaimer;
//   * a session_shutdown bumps the generation; no in-flight async continuation
//     may mutate state, reschedule, or deliver after shutdown;
//   * claim-false and transient claim failures never produce a zero-delay spin;
//   * an out-of-scope claimed task is abandoned to pending without firing and
//     without incrementing runCount.

"use strict";

const core = require("./scheduler-core.cjs");
const runtime = require("./scheduler-runtime.cjs");

// Bounded retry for the case where a one-shot timer has already removed its
// handle but the store claim failed (lock contention / transient error).
const FIRE_CLAIM_RETRIES = 3;
const FIRE_CLAIM_RETRY_BASE_MS = 50;
const FIRE_CLAIM_RETRY_MAX_MS = 250;

function sleep(clock, ms) {
	return new Promise((resolve) => clock.setTimeout(resolve, ms));
}

function nowMs(clock) {
	const value = clock.now();
	return value instanceof Date ? value.getTime() : Number(value);
}

function createEngine(options) {
	const {
		store,
		runnerId,
		clock,
		leaseMsForTask,
		normalize,
		run,
		maxTimerDelayMs,
		recovery = {},
	} = options;
	const recoveryMinDelayMs = recovery.minDelayMs ?? 1000;
	const recoveryMaxDelayMs = recovery.maxDelayMs ?? maxTimerDelayMs;

	// Consolidated mutable state, previously scattered across the index.ts
	// closure. Owned exclusively by the engine.
	let tasks = [];
	const handles = new Map(); // taskId -> { kind, handle }
	const firing = new Set();
	let sessionGeneration = 0;
	let isShutdown = false;
	let recoveryTimer = null;
	let bound = null; // { isInScope, execute, reportTaskFailure, reportPersistenceFailure, onChange }

	function notify() {
		if (bound?.onChange) bound.onChange();
	}

	function clearHandle(id) {
		const handle = handles.get(id);
		if (!handle) return;
		if (handle.kind === "cron") handle.handle.stop();
		else clock.clearTimeout(handle.handle);
		handles.delete(id);
	}

	function clearTimers() {
		for (const id of [...handles.keys()]) clearHandle(id);
	}

	async function reloadMirror() {
		// Read-only transaction: acquire the lock, read current state, release.
		// Guarantees the in-memory mirror is consistent with on-disk state.
		tasks = await store.transaction((current) => normalize(current.slice()));
	}

	// Reload mirror from the store, then reschedule + arm recovery. Called at
	// bind/startup and after every persisted mutation (index calls refresh()).
	async function refresh() {
		if (isShutdown) return;
		await reloadMirror();
		if (isShutdown) return;
		rescheduleAll();
	}

	function rescheduleAll() {
		clearTimers();
		for (const task of core.pendingTasks(tasks)) scheduleTaskHandle(task);
		armLeaseRecovery();
		notify();
	}

	function scheduleTaskHandle(task) {
		if (task.enabled === false || task.status !== "pending") return;
		if (bound && !bound.isInScope(task)) return;
		clearHandle(task.id);

		if (task.type === "cron") {
			try {
				const cron = new clock.Cron(task.schedule, () => {
					void fireTask(task.id);
				});
				handles.set(task.id, { kind: "cron", handle: cron });
			} catch (error) {
				// Persist the failed cron parse through the store, not a bare save.
				void persistCronFailure(task.id, error);
			}
			return;
		}

		const dueAt = Date.parse(task.nextRun ?? task.dueAt);
		if (!Number.isFinite(dueAt)) return;
		const now = nowMs(clock);
		const delay = Math.max(0, dueAt - now);
		const timerDelay = Math.min(delay, maxTimerDelayMs);

		const timer = clock.setTimeout(() => {
			handles.delete(task.id);
			// A one-shot timer may fire before the true due time if the delay was
			// capped by maxTimerDelayMs (~24.8 days). Re-arm for the remainder
			// instead of firing prematurely.
			if (nowMs(clock) < dueAt) {
				scheduleTaskHandle(task);
				return;
			}
			void fireTask(task.id);
		}, timerDelay);
		handles.set(task.id, { kind: "timeout", handle: timer });
	}

	async function persistCronFailure(taskId, error) {
		try {
			await store.transaction((current) => {
				const failed = current.find((candidate) => candidate.id === taskId);
				if (failed) {
					failed.enabled = false;
					failed.status = "failed";
					failed.lastStatus = "error";
					failed.lastError = error?.message ?? String(error);
				}
			});
			await reloadMirror();
			if (isShutdown) return;
			rescheduleAll();
		} catch {
			// Best-effort: a cron parse failure must not crash the engine.
		}
	}

	// Arm a single bounded lease-expiry recovery sweep. If a persisted task is
	// RUNNING with a resolvable lease, schedule one timer to fire just past its
	// expiry that reloads state and reclaims expired-lease tasks. No-op when no
	// running task has a lease. Always uses a NON-ZERO delay (no busy-loop).
	function armLeaseRecovery() {
		if (isShutdown) return;
		if (recoveryTimer) {
			clock.clearTimeout(recoveryTimer);
			recoveryTimer = null;
		}
		const delay = runtime.nextLeaseRecoveryDelay(tasks, clock.now(), {
			minDelayMs: recoveryMinDelayMs,
			maxDelayMs: recoveryMaxDelayMs,
		});
		if (delay === null) return;
		recoveryTimer = clock.setTimeout(() => {
			recoveryTimer = null;
			void recoverExpiredLeases();
		}, delay);
	}

	async function refreshAfterMutation(originGeneration) {
		if (isShutdown) return;
		try {
			await reloadMirror();
		} catch {
			// A later operation will retry the persisted reload.
			return;
		}
		if (isShutdown) return;
		rescheduleAll();
		// originGeneration is informational here; the engine has no successor
		// session concept, so a stale generation simply re-arms the current view.
		void originGeneration;
	}

	// Reload state, find persisted RUNNING tasks with expired leases, and
	// reclaim them through the store so a crashed owner does not strand a task.
	// After reclaiming, reload + reschedule so the reclaimed task's next run is
	// armed. Guarded by the session generation so a sweep that fires after
	// shutdown does not mutate state.
	async function recoverExpiredLeases() {
		if (isShutdown) return;
		const generation = sessionGeneration;
		try {
			const current = await store.transaction((snapshot) => snapshot.slice());
			const expired = runtime.tasksWithExpiredLeases(current, clock.now());
			if (expired.length === 0) {
				if (generation === sessionGeneration && !isShutdown) {
					// Another process may have completed/re-armed the task since this
					// engine loaded it. Refresh the mirror before rebuilding timers.
					await reloadMirror();
					if (generation === sessionGeneration && !isShutdown) rescheduleAll();
				}
				return;
			}
			for (const task of expired) {
				// Reclaim via a targeted claim; the store recovers the expired lease.
				const claimed = await store.claimDueTask({
					runnerId,
					taskId: task.id,
					now: clock.now(),
					leaseMs: leaseMsForTask(task),
				});
				// We do NOT execute the reclaimed task here: an expired lease means
				// the previous owner may still be finishing. Restore it to pending
				// via abandon so the next eligible run picks it up cleanly.
				if (claimed?.claimed) {
					await safeReleaseClaim(claimed.task, claimed.claimToken);
				}
			}
			await refreshAfterMutation(generation);
		} catch {
			// A transient store/claim failure must not strand an expired lease.
			// Reload when possible, then re-arm recovery; nextLeaseRecoveryDelay
			// applies a non-zero floor, so this retries without busy-looping.
			if (generation === sessionGeneration && !isShutdown) {
				try {
					await reloadMirror();
				} catch {
					// Keep the prior snapshot; it still identifies the running lease.
				}
				if (generation === sessionGeneration && !isShutdown) armLeaseRecovery();
			}
		}
	}

	// Abandon a claim we should not execute (out-of-scope, or shutdown during
	// claim) WITHOUT marking it fired. Clears claim metadata and restores the
	// task to pending. runCount is NOT incremented. Only the claim owner may
	// abandon its own claim.
	async function safeReleaseClaim(task, claimToken) {
		try {
			await store.abandonClaimedTask({
				taskId: task.id,
				runnerId,
				claimToken,
				now: clock.now(),
			});
			await reloadMirror();
		} catch {
			// If abandon fails (e.g. lease already expired and reclaimed by a new
			// in-scope runner), the store's lease recovery handles it. The task is
			// not marked fired here under any path.
		}
	}

	// Bounded, NON-ZERO rearm after a claim-false/transient failure when the
	// post-claim reload also failed (so the pending task is not stranded).
	function scheduleClaimRetry(taskId, generation, attempt) {
		if (generation !== sessionGeneration || isShutdown) return;
		clearHandle(taskId);
		const delay = runtime.claimFalseRearmDelay(attempt);
		const timer = clock.setTimeout(() => {
			handles.delete(taskId);
			if (generation !== sessionGeneration || isShutdown) return;
			void fireTask(taskId, attempt + 1);
		}, delay);
		handles.set(taskId, { kind: "timeout", handle: timer });
	}

	async function fireTask(taskId, rearmAttempt = 0) {
		// Claim the due task atomically through the store. Only the claim owner
		// (matching runnerId + claimToken) may execute and complete. An expired
		// lease is recovered by the store so a new runner can reclaim it later.
		// The `firing` guard prevents the same process racing two timers.
		if (firing.has(taskId)) return;
		const generation = sessionGeneration;
		if (isShutdown) return;

		// Size the lease to this task's execution timeout (with margin) before
		// claiming, so a slow custom-timeout run is not stolen by another runner.
		const known = tasks.find((candidate) => candidate.id === taskId);
		const leaseMs = leaseMsForTask(known ?? {});

		// Bounded retry: a one-shot timer removes its handle BEFORE calling
		// fireTask, so if the claim throws the pending task would otherwise be
		// stranded with no timer. Retry a few times for transient lock/contention
		// failures; if all retries fail, re-arm via reschedule so it is not lost.
		let claimed;
		let lastClaimError;
		for (let attempt = 0; attempt <= FIRE_CLAIM_RETRIES; attempt++) {
			try {
				claimed = await store.claimDueTask({
					runnerId,
					taskId,
					now: clock.now(),
					leaseMs,
				});
				lastClaimError = undefined;
				break;
			} catch (error) {
				lastClaimError = error;
				if (attempt >= FIRE_CLAIM_RETRIES) break;
				if (generation !== sessionGeneration || isShutdown) return;
				const backoff = Math.min(
					FIRE_CLAIM_RETRY_MAX_MS,
					FIRE_CLAIM_RETRY_BASE_MS * 2 ** attempt,
				);
				await sleep(clock, backoff);
				if (generation !== sessionGeneration || isShutdown) return;
			}
		}

		// Shutdown may occur while claimDueTask is awaiting the store lock. Never
		// execute after the generation changes. If this runner acquired the claim
		// during that window, release it without completing or rescheduling.
		if (generation !== sessionGeneration || isShutdown) {
			if (claimed?.claimed) {
				await safeReleaseClaim(claimed.task, claimed.claimToken);
			}
			return;
		}

		if (lastClaimError) {
			// All claim attempts failed. Re-arm pending tasks to avoid stranding
			// this (and any other) due task. A later tick or another runner will
			// retry the claim.
			if (generation !== sessionGeneration || isShutdown) return;
			let reloaded = false;
			try {
				await reloadMirror();
				reloaded = true;
			} catch {
				// Fall through to the bounded retry path below.
			}
			if (generation !== sessionGeneration || isShutdown) return;
			if (reloaded) rescheduleAll();
			else scheduleClaimRetry(taskId, generation, rearmAttempt);
			return;
		}
		if (!claimed?.claimed) {
			// Claim returned false (task already claimed by another runner, or not
			// due). Reload and re-arm so a crashed owner is reclaimed after its
			// lease expires. Bounded, NON-ZERO rearm avoids a zero-delay spin.
			if (generation !== sessionGeneration || isShutdown) return;
			let reloaded = false;
			try {
				await reloadMirror();
				reloaded = true;
			} catch {
				// Fall through to the bounded retry path below.
			}
			if (generation !== sessionGeneration || isShutdown) return;
			if (reloaded) rescheduleAll();
			else scheduleClaimRetry(taskId, generation, rearmAttempt);
			return;
		}

		const task = claimed.task;
		// Scope filter: only this session/cwd/global task fires here. If the claim
		// was for a task outside our scope, abandon the claim (restore pending, no
		// runCount bump) so the lease is cleared and the task stays pending for a
		// future eligible run — do NOT mark it fired.
		if (bound && !bound.isInScope(task)) {
			await safeReleaseClaim(task, claimed.claimToken);
			if (generation === sessionGeneration && !isShutdown) {
				await reloadMirror();
				if (isShutdown) return;
				rescheduleAll();
			}
			return;
		}

		firing.add(task.id);
		const claimToken = claimed.claimToken;
		const claimGeneration = claimed.claimGeneration;
		// Settle the claimed execution lifecycle through the injected run helper
		// (runClaimedExecution) so policy concerns stay cohesive and testable.
		// The engine owns completion, live-gated reload, and failure/persistence
		// reports; the finally keeps the unconditional firing.delete and the
		// live-only reschedule.
		try {
			notify();
			await run(
				task,
				{ taskId: task.id, runnerId, claimToken, claimGeneration },
				{
					execute: (t) =>
						bound.execute(
							t,
							() => generation === sessionGeneration && !isShutdown,
						),
					complete: async ({ result, ok }) => {
						// Persist the outcome even if shutdown occurred while the action
						// was running: the action may already have produced external side
						// effects, and leaving its claim running would let lease recovery
						// execute it again.
						await store.completeClaimedTask({
							taskId: task.id,
							runnerId,
							claimToken,
							claimGeneration,
							result,
							now: clock.now(),
							ok,
						});
					},
					reload: async () => {
						await reloadMirror();
						// If this execution belongs to an older generation, refresh and
						// re-arm the currently active successor session.
						if (generation !== sessionGeneration && !isShutdown)
							rescheduleAll();
					},
					isLive: () => generation === sessionGeneration && !isShutdown,
					shouldReload: () => !isShutdown,
					reportTaskFailure: (error) => bound.reportTaskFailure(task, error),
					reportPersistenceFailure: (error) =>
						bound.reportPersistenceFailure(task, error),
				},
			);
		} finally {
			firing.delete(task.id);
			// Only reschedule if the session is still live (same generation). An
			// in-flight fireTask that resolves after shutdown must not re-arm timers
			// or mutate UI state.
			if (generation === sessionGeneration && !isShutdown) rescheduleAll();
		}
	}

	function bind(deps) {
		bound = deps;
		// A new session reuses this engine instance (Pi emits session_start for
		// the same factory closure after a session_shutdown). Re-arm it: the
		// generation was bumped at shutdown, so stale continuations from the
		// prior session stay blocked, while the new session may schedule again.
		isShutdown = false;
	}

	function snapshot() {
		return tasks.slice();
	}

	function shutdown() {
		isShutdown = true;
		sessionGeneration++;
		clearTimers();
		if (recoveryTimer) {
			clock.clearTimeout(recoveryTimer);
			recoveryTimer = null;
		}
	}

	return { bind, refresh, snapshot, shutdown };
}

module.exports = { createEngine };
