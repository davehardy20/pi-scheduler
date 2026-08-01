// Runtime helpers for the scheduler extension, extracted from index.ts so the
// runtime/policy concerns stay cohesive and testable without booting a full Pi
// process (lead review: keep index.ts focused; high fix 2 + claim-error rearm).
//
// Responsibilities:
//   * lease-expiry recovery: detect persisted RUNNING tasks whose leases have
//     expired and reclaim them so a crashed owner does not strand a task, and
//     schedule a bounded recovery sweep so a task left running by a crashed
//     process is reclaimed after its lease expires.
//   * claim-error rearm: compute a bounded, NON-ZERO rearm delay so a claim
//     that fails under contention does not spin in a zero-delay infinite loop.
//   * message-detail redaction: strip shell command argv and prompt fields from
//     custom-message details so only safe identifiers/metadata are surfaced.

"use strict";

/**
 * Find persisted tasks that are in a RUNNING state with an EXPIRED lease. These
 * were left running by a process that crashed mid-claim; a later runner must
 * reclaim them so they are not stranded. This is a pure read over the current
 * task list (the store's claim path performs the actual reclaim).
 *
 * @param {Array} tasks
 * @param {Date} now
 * @returns {Array} tasks eligible for lease-expiry recovery (running + expired)
 */
function tasksWithExpiredLeases(tasks, now = new Date()) {
	const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
	if (!Number.isFinite(nowMs)) return [];
	if (!Array.isArray(tasks)) return [];
	return tasks.filter((task) => {
		if (task?.status !== "running") return false;
		const expiresMs = Date.parse(task.claimLeaseExpiresAt ?? "");
		return Number.isFinite(expiresMs) && expiresMs <= nowMs;
	});
}

/**
 * Schedule a bounded lease-expiry recovery sweep. Returns the delay (ms) until
 * the NEXT expired-lease task should be reclaimed, or null when no running task
 * has a resolvable lease. The runtime uses this to arm a single recovery timer
 * so persisted running tasks are reclaimed after their leases expire without
 * polling on a zero-delay loop.
 *
 * The delay is always at least `minDelayMs` (default 1s) so recovery never
 * busy-loops: a task whose lease is already expired is reclaimed promptly but
 * not in a spin.
 *
 * The delay is never larger than `maxDelayMs` (when finite and >= 1): a
 * far-future lease (beyond Node's setTimeout practical max of ~24.8 days)
 * would otherwise arm a timer that Node clamps to ~1ms, busy-looping recovery.
 * Capping lets the recovery callback fire within the timer max and re-arm
 * against the absolute expiry, so the task is still reclaimed promptly once
 * its lease actually expires.
 *
 * @param {Array} tasks
 * @param {Date} now
 * @param {object} [options]
 * @returns {number|null}
 */
function nextLeaseRecoveryDelay(tasks, now = new Date(), options = {}) {
	const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
	if (!Number.isFinite(nowMs)) return null;
	// Defensive minDelayMs: only a finite number >= 1 is honored; anything else
	// (NaN, Infinity, <=0, non-numeric) falls back to the 1000ms default. This
	// prevents NaN from poisoning the recovery delay (Math.max(1, NaN) === NaN)
	// and keeps recovery from busy-looping on a malformed option.
	const rawMin = Number(options.minDelayMs);
	const minDelayMs = Number.isFinite(rawMin) && rawMin >= 1 ? rawMin : 1000;
	// Optional upper bound. Validated the same shape as minDelayMs: only a finite
	// number >= 1 is honored, so a malformed/absent value leaves the delay
	// uncapped (preserving prior behavior) rather than clamping to 0.
	const rawMax = Number(options.maxDelayMs);
	const maxDelayMs = Number.isFinite(rawMax) && rawMax >= 1 ? rawMax : null;
	if (!Array.isArray(tasks)) return null;
	let earliest = null;
	for (const task of tasks) {
		if (task?.status !== "running") continue;
		const expiresMs = Date.parse(task.claimLeaseExpiresAt ?? "");
		if (!Number.isFinite(expiresMs)) continue;
		if (earliest === null || expiresMs < earliest) earliest = expiresMs;
	}
	if (earliest === null) return null;
	const raw = earliest - nowMs;
	// Always at least minDelayMs so a just-expired lease does not spin; if the
	// earliest lease is far in the future, wait until just past it (clamped to
	// maxDelayMs when provided so the timer never exceeds Node's practical max).
	let delay = Math.max(minDelayMs, raw + 1);
	if (maxDelayMs !== null) {
		// The effective cap never drops the result below minDelayMs, so a
		// caller-supplied maxDelayMs below minDelayMs cannot busy-loop recovery.
		delay = Math.min(delay, Math.max(maxDelayMs, minDelayMs));
	}
	return delay;
}

/**
 * Bounded rearm delay for a claim that returned FALSE (no task claimed). The
 * runtime must reload and re-arm so a crashed owner is reclaimed after expiry,
 * but it must NOT spin in a zero-delay infinite loop. Returns a small but
 * NON-ZERO delay so the loop yields control.
 *
 * @param {number} attempt  zero-based rearm attempt counter
 * @returns {number} delay in ms (always >= 1)
 */
function claimFalseRearmDelay(attempt = 0) {
	const base = 100; // 100ms baseline
	const backoff = Math.min(2000, base * 2 ** Math.max(0, attempt));
	return Math.max(1, backoff);
}

/**
 * Redact a task for inclusion in a Pi custom-message `details` field. Shell
 * command argv and prompt/message text can carry secrets or sensitive content,
 * so only SAFE identifiers and execution metadata are retained. The full task
 * stays in the persisted store and the in-memory follow-up prompt; this only
 * governs what is surfaced in the chat message details.
 *
 * @param {object} task
 * @returns {object} a redacted, message-safe view of the task
 */
function redactTaskForMessage(task) {
	if (!task || typeof task !== "object") return {};
	const safe = {
		id: task.id,
		action: task.action,
		type: task.type,
		status: task.status,
		enabled: task.enabled,
		scope: task.scope,
		schedule: task.schedule,
		name: task.name,
		runCount: task.runCount,
		nextRun: task.nextRun,
		lastStatus: task.lastStatus,
	};
	// For shell tasks, keep only the executable identity (not argv, not the
	// command object text) so command-line secrets are not surfaced.
	if (task.action === "shell") {
		const command = task.command;
		if (command && typeof command === "object") {
			safe.executable = command.executable;
		} else if (typeof command === "string") {
			// Legacy string command: surface only that it is a legacy string,
			// never the text.
			safe.legacyCommand = true;
		}
	}
	return safe;
}

/**
 * Redact a shell execution result for message details. Only safe exit metadata
 * is retained; stdout/stderr and argv are never included.
 *
 * @param {object} result
 * @returns {object}
 */
function redactResultForMessage(result) {
	if (!result || typeof result !== "object") return {};
	return {
		ok: result.ok,
		executable: result.executable,
		cwd: result.cwd,
		timeoutMs: result.timeoutMs,
		code: result.code,
		killed: result.killed,
	};
}

/**
 * Build the durable custom-message summary for a shell completion without
 * including argv, stdout, stderr, or prompt text. Those fields may contain
 * secrets; the persisted session message carries only task/executable/exit
 * identity.
 *
 * @param {object} task
 * @param {object} result
 * @returns {string}
 */
function shellCompletionMessage(task, result) {
	const id = task?.id ?? "unknown";
	const executable = result?.executable ?? "unknown executable";
	const code = result?.code ?? "unknown";
	return `🖥️ Scheduled command ${id} (${executable}) finished with exit code ${code}`;
}

/**
 * Render a structured command for display WITHOUT stringifying the object to
 * "[object Object]". Used by the message renderer and follow-up rendering so a
 * structured { executable, argv } command renders readably.
 *
 * @param {object|string|undefined} command
 * @returns {string}
 */
function renderCommand(command) {
	if (command && typeof command === "object") {
		const exe = command.executable ?? "(no executable)";
		const argv = Array.isArray(command.argv) ? command.argv : [];
		return [exe, ...argv].map(String).join(" ");
	}
	if (typeof command === "string") return command;
	return "(no command)";
}

/**
 * Settle a claimed task's fire-time execution lifecycle, isolating the policy
 * concerns that were previously inlined (and conflated) inside index.ts's
 * fireTask try/catch/finally. This is HIGH fix 1: separate executeTask
 * rejection from success-completion/reload errors.
 *
 * Dependencies are INJECTED so this helper is pure to test with fakes (no Pi
 * process, no store, no UI). The caller (index.ts) wires them to its real
 * execute/complete/reload implementations and its live-session gate.
 *
 * Invariants enforced here, regardless of `isLive()`:
 *   * `execute()` rejection is the ONLY outcome that may persist `{ok:false}`.
 *     It is always attempted regardless of liveness, so lease recovery never
 *     re-executes a failed task.
 *   * After `execute()` returns a result, completion with `{result, ok}` is
 *     ALWAYS attempted regardless of liveness (the action may have produced
 *     external side effects; leaving the claim running would re-fire it).
 *   * A success/result COMPLETION error is NEVER downgraded to `{ok:false}`.
 *     If live, it reports a PERSISTENCE failure; if not live, it is silent.
 *     Either way no `{ok:false}` is written and no task-failed is reported.
 *   * `reload()` is gated on `shouldReload()` (defaulting to `isLive()`) so a
 *     successor session can refresh an older generation's durable completion.
 *   * Failure/persistence reports remain gated on the originating `isLive()`.
 *   * A `reload()` error after durable success never reports task-failed
 *     (reload is best-effort) and never downgrades to `{ok:false}`.
 *
 * The caller owns the unconditional `firing.delete` and live-only
 * `rescheduleAll` (still in index.ts's finally).
 *
 * @param {object} task the claimed task
 * @param {object} claim claim descriptor (taskId, runnerId, claimToken, claimGeneration). Kept in the signature for API clarity/stability; the caller's injected `complete` closure is responsible for using the claim identity, so the helper itself does not read it.
 * @param {object} deps injected behavior
 * @param {() => Promise<any>} deps.execute runs the task action; rejection => ok:false
 * @param {(payload: {result?: any, ok: boolean}) => Promise<void>} deps.complete persists the outcome
 * @param {() => Promise<void>} [deps.reload] best-effort in-memory mirror refresh
 * @param {() => boolean} deps.isLive true while the originating session is live
 * @param {() => boolean} [deps.shouldReload] true when any active session needs the durable update
 * @param {(error: any, task: object) => void} [deps.reportTaskFailure] live failure surface (UI/message)
 * @param {(error: any, task: object, result: any) => void} [deps.reportPersistenceFailure] live persistence-failure surface
 * @returns {Promise<void>}
 */
async function runClaimedExecution(task, _claim, deps) {
	const {
		execute,
		complete,
		reload,
		isLive,
		shouldReload = isLive,
		reportTaskFailure,
		reportPersistenceFailure,
	} = deps;

	let result;
	let executeRejected = false;
	let executeError;
	try {
		result = await execute(task);
	} catch (error) {
		executeRejected = true;
		executeError = error;
	}

	if (executeRejected) {
		// Only an execute rejection may persist ok:false. This is unconditional
		// (not gated on isLive) so lease recovery does not normally re-execute the
		// task. If persistence itself fails, preserve both error identities rather
		// than suppressing the original task-failure report.
		let completionError;
		try {
			await complete({ result: undefined, ok: false });
		} catch (error) {
			completionError = error;
		}
		if (!completionError && shouldReload() && reload) {
			try {
				await reload();
			} catch {
				// reload is best-effort after durable failed completion.
			}
		}
		if (isLive()) {
			if (completionError && reportPersistenceFailure) {
				reportPersistenceFailure(completionError, task, undefined);
			}
			if (reportTaskFailure) reportTaskFailure(executeError, task);
		}
		return;
	}

	// execute() returned a result. Completion with {result, ok} is always
	// attempted regardless of liveness; ok reflects the result, not a failure
	// elsewhere. A completion error here is NEVER downgraded to ok:false.
	try {
		await complete({ result, ok: result?.ok !== false });
	} catch (completionError) {
		if (isLive() && reportPersistenceFailure) {
			reportPersistenceFailure(completionError, task, result);
		}
		return;
	}

	// Completion is durable. reload is best-effort and active-session-gated; its
	// failure never reports task-failed and never downgrades to ok:false.
	if (shouldReload() && reload) {
		try {
			await reload();
		} catch {
			// reload is best-effort after durable success; swallow.
		}
	}
}

module.exports = {
	tasksWithExpiredLeases,
	nextLeaseRecoveryDelay,
	claimFalseRearmDelay,
	redactTaskForMessage,
	redactResultForMessage,
	shellCompletionMessage,
	renderCommand,
	runClaimedExecution,
};
