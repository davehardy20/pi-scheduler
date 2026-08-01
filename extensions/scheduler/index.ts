// biome-ignore-all lint/suspicious/noExplicitAny: Pi extension callbacks and the persisted CJS task schema are dynamically typed.

import { randomBytes } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Cron } from "croner";
import { Type } from "typebox";

// Keep the scheduler logic testable from plain node --test.
const core = require("./scheduler-core.cjs");
// Runtime helpers: lease-expiry recovery, claim-false rearm, and message-detail
// redaction. Extracted so the runtime/policy concerns stay cohesive and
// testable without booting a full Pi process.
const runtime = require("./scheduler-runtime.cjs");
// Locked, cross-process task store. Every persisted load/mutate/save goes
// through store.transaction() so read-modify-write is serialized and state is
// reloaded while the lock is held.
const { createTaskStore } = require("./task-store.cjs");
// Deny-by-default execution policy. Direct process execution is DISABLED unless
// a user-owned policy file explicitly opts in with an allowlist. Legacy command
// strings fail closed; structured { executable, argv } commands are validated at
// scheduling time and revalidated immediately before firing, then run directly
// (never through a shell).
//
// The policy is loaded FRESH from disk for every scheduling and firing
// decision: there is no session-wide cache. Each decision re-reads the file,
// re-validates that it is a regular user-owned file (rejecting group/world-
// writable mode on POSIX), re-parses it, and then evaluates. So a policy
// revocation or edit takes effect at the next decision without a restart.
const { loadPolicyFromFile, migrateTask } = require("./execution-policy.cjs");

const ACTIONS = ["notify", "prompt", "shell", "message"] as const;
const TYPES = ["once", "interval", "cron"] as const;
const SCOPES = ["session", "cwd", "global"] as const;
const WAKE_ON = ["always", "failure", "success", "never"] as const;
const MANAGE_ACTIONS = [
	"enable",
	"disable",
	"remove",
	"update",
	"cleanup",
] as const;

const STATE_DIR = join(homedir(), ".pi", "agent", "state", "scheduler");
const STATE_FILE = join(STATE_DIR, "tasks.json");
// Restrictive user-owned execution policy. Absent/malformed => fail closed.
const POLICY_FILE = join(STATE_DIR, "scheduler-policy.json");
const MAX_TIMER_DELAY_MS = 2_147_483_647; // setTimeout's practical max (~24.8 days)
const DEFAULT_SHELL_TIMEOUT_MS = 5 * 60 * 1000;
// Lease must cover execution timeout with margin so a slow run is not stolen.
const LEASE_MARGIN_MS = 60_000;
const MIN_LEASE_MS = 30_000;
const MAX_PROMPT_OUTPUT_CHARS = 18_000;

type ScheduledTask = Record<string, any>;
type TimerHandle =
	| { kind: "timeout"; handle: NodeJS.Timeout }
	| { kind: "cron"; handle: Cron };

function truncateMiddle(text: string | undefined, maxChars: number): string {
	const value = text ?? "";
	if (value.length <= maxChars) return value;
	const head = Math.floor(maxChars * 0.35);
	const tail = maxChars - head - 80;
	return `${value.slice(0, head)}\n\n[... truncated ${value.length - maxChars} characters ...]\n\n${value.slice(-tail)}`;
}

function currentSessionFile(ctx: ExtensionContext): string | undefined {
	return ctx.sessionManager.getSessionFile() ?? undefined;
}

function taskBelongsToSession(
	task: ScheduledTask,
	ctx: ExtensionContext,
): boolean {
	const scope = task.scope ?? "session";
	if (scope === "global") return true;
	if (scope === "cwd") return !task.cwd || task.cwd === ctx.cwd;

	const sessionFile = currentSessionFile(ctx);
	return !task.sessionFile || !sessionFile || task.sessionFile === sessionFile;
}

function sendAgentPrompt(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	prompt: string,
): void {
	if (ctx.isIdle()) {
		pi.sendUserMessage(prompt);
	} else {
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
	}
}

function scheduledPromptHeader(task: ScheduledTask): string {
	return [
		`[Scheduled task ${task.id} fired]`,
		`Name: ${task.name ?? task.title ?? "(unnamed)"}`,
		`Action: ${task.action}`,
		`Type: ${task.type}`,
		`Schedule: ${task.schedule}`,
		`Scheduled for: ${task.nextRun ?? task.dueAt ?? "unknown"}`,
		"",
	].join("\n");
}

function taskCreatedText(task: ScheduledTask): string {
	const label = task.name ? ` "${task.name}"` : "";
	const next = task.nextRun
		? ` next run ${new Date(task.nextRun).toLocaleString()}`
		: "";
	return `Scheduled ${task.action}/${task.type} task${label} ${task.id}${next}: ${core.taskSummary(task)}`;
}

function shellResultPrompt(
	task: ScheduledTask,
	result: Record<string, any>,
	instruction: string,
): string {
	const stdout = truncateMiddle(result.stdout ?? "", MAX_PROMPT_OUTPUT_CHARS);
	const stderr = truncateMiddle(result.stderr ?? "", MAX_PROMPT_OUTPUT_CHARS);
	return [
		scheduledPromptHeader(task).trimEnd(),
		"A scheduled shell command completed.",
		"",
		`Command: ${runtime.renderCommand(task.command)}`,
		`CWD: ${result.cwd}`,
		`Exit code: ${result.code}`,
		`Timed out/killed: ${Boolean(result.killed)}`,
		"",
		"STDOUT:",
		"```",
		stdout,
		"```",
		"",
		"STDERR:",
		"```",
		stderr,
		"```",
		"",
		"Follow-up instruction:",
		instruction,
	].join("\n");
}

function taskLabel(task: ScheduledTask): string {
	return task.name || task.title || task.id;
}

export default function schedulerExtension(pi: ExtensionAPI) {
	let tasks: ScheduledTask[] = [];
	const handles = new Map<string, TimerHandle>();
	let activeCtx: ExtensionContext | undefined;
	let widgetEnabled = true;
	const firing = new Set<string>();
	// Session generation: bumped on session_shutdown so any in-flight fireTask can
	// detect that the session has ended and refuse to reschedule/complete after
	// shutdown (medium fix 6). A stale in-flight task that resolves after
	// shutdown must not re-arm timers or mutate state.
	let sessionGeneration = 0;
	let isShutdown = false;
	// Lease-expiry recovery timer: arms a single bounded sweep so persisted
	// RUNNING tasks whose owners crashed are reclaimed after their leases
	// expire (high fix 2). Re-armed on each reload/reschedule.
	let recoveryTimer: NodeJS.Timeout | undefined;

	// Stable, unique runner identity for this Pi process. Used as the claim owner
	// so only the process that claimed a task can complete it; other processes
	// (or a recovering owner after lease expiry) reclaim expired claims.
	const runnerId = `pi_${hostname()}_${process.pid}_${randomBytes(6).toString("hex")}`;

	// Locked, cross-process task store. Every persisted read-modify-write goes
	// through store.transaction(); state is reloaded from disk while the lock is
	// held, then mirrored into the in-memory `tasks` array for timers/UI. The
	// onWarning callback surfaces malformed-state recovery to the user (medium
	// fix 8) so a quarantined state file is not silent.
	const taskStore = createTaskStore({
		filePath: STATE_FILE,
		onWarning: (message: string) => {
			try {
				pi.sendMessage(
					{
						customType: "scheduled-task",
						content: `⚠️ ${message}`,
						display: true,
						details: { warning: true },
					},
					{ triggerTurn: false },
				);
			} catch {
				// Surfacing a warning is best-effort; never let it break the store.
			}
		},
	});

	// Execution policy. Loaded FRESH from disk for every scheduling and firing
	// decision by `freshPolicy()` below — nothing is cached for the session. A
	// user editing, chmod'ing, chown'ing, or removing scheduler-policy.json
	// takes effect at the next decision without a restart. Absent or malformed /
	// non-user-owned / group-or-world-writable policy => deny-by-default (fail
	// closed). See loadPolicyFromFile() for the validation rules.
	function freshPolicy() {
		return loadPolicyFromFile(POLICY_FILE);
	}

	function leaseMsForTask(task: ScheduledTask): number {
		const timeout = Number(task.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS);
		const base =
			Number.isFinite(timeout) && timeout > 0
				? timeout
				: DEFAULT_SHELL_TIMEOUT_MS;
		// Cover execution timeout with a margin so a slow run is not stolen, but
		// never shorter than a floor that keeps safe (non-shell) actions alive.
		return Math.max(MIN_LEASE_MS, base * 2 + LEASE_MARGIN_MS);
	}

	async function reloadTasks(): Promise<void> {
		// Read-only transaction: acquire the lock, read current state, release.
		// This guarantees the in-memory view is consistent with on-disk state.
		// Legacy persisted shell tasks are migrated so a bare command string is
		// preserved for display but flagged autoExecute:false (never run) until
		// the user re-creates it with structured argv.
		tasks = await taskStore.transaction((current: any[]) =>
			core
				.sanitizeTasks(current.slice())
				.map((task: ScheduledTask) => migrateTask(task)),
		);
	}

	async function withTransaction<T>(
		fn: (current: ScheduledTask[]) => T | Promise<T>,
	): Promise<T> {
		const result = await taskStore.transaction(async (current: any[]) => {
			// Reload/normalize inside the lock so the mutator sees prior commits.
			const normalized = core.sanitizeTasks(current.slice());
			const ret = await fn(normalized);
			// Replace the store array contents in place with the normalized result
			// so persisted state reflects exactly what the mutator produced.
			current.length = 0;
			for (const task of normalized) current.push(task);
			return ret;
		});
		// Mirror into memory after a successful commit.
		await reloadTasks();
		return result;
	}

	function clearHandle(id: string): void {
		const handle = handles.get(id);
		if (!handle) return;
		if (handle.kind === "cron") handle.handle.stop();
		else clearTimeout(handle.handle);
		handles.delete(id);
	}

	function clearTimers(): void {
		for (const id of [...handles.keys()]) clearHandle(id);
	}

	function visibleTasks(ctx = activeCtx): ScheduledTask[] {
		if (!ctx) return tasks;
		return tasks.filter((task) => taskBelongsToSession(task, ctx));
	}

	function updateWidget(ctx = activeCtx): void {
		if (!ctx?.hasUI) return;
		if (!widgetEnabled) {
			ctx.ui.setWidget("scheduler", undefined);
			return;
		}

		const upcoming = core.pendingTasks(visibleTasks(ctx)).slice(0, 3);
		if (upcoming.length === 0) {
			ctx.ui.setWidget("scheduler", undefined);
			return;
		}

		const lines = ["⏰ Scheduled Actions"];
		for (const task of upcoming) {
			const relative = task.nextRun
				? core.formatRelativeTime(task.nextRun)
				: "no next run";
			const absolute = task.nextRun
				? core.formatAbsoluteTime(task.nextRun)
				: "";
			const when = absolute ? `${relative} (${absolute})` : relative;
			const last = task.lastStatus ? ` last=${task.lastStatus}` : "";
			lines.push(
				`  ✓ ${taskLabel(task)} ${task.action}/${task.type} ${when} runs=${task.runCount ?? 0}${last}`,
			);
		}
		ctx.ui.setWidget("scheduler", lines, { placement: "belowEditor" });
	}

	function updateStatus(ctx = activeCtx): void {
		if (!ctx?.hasUI) return;
		const count = core.pendingTasks(visibleTasks(ctx)).length;
		ctx.ui.setStatus("scheduler", count ? `⏰ ${count} scheduled` : undefined);
		updateWidget(ctx);
	}

	function scheduleTaskHandle(
		task: ScheduledTask,
		ctx: ExtensionContext,
	): void {
		if (task.enabled === false || task.status !== "pending") return;
		if (!taskBelongsToSession(task, ctx)) return;
		clearHandle(task.id);

		if (task.type === "cron") {
			try {
				const cron = new Cron(task.schedule, () => {
					void fireTask(task.id, ctx);
				});
				handles.set(task.id, { kind: "cron", handle: cron });
			} catch (error: any) {
				// Persist the failed cron parse through the store, not a bare save.
				void withTransaction((current) => {
					const failed = core.findTask(current, task.id);
					if (failed) {
						failed.enabled = false;
						failed.status = "failed";
						failed.lastStatus = "error";
						failed.lastError = error?.message ?? String(error);
					}
				});
			}
			return;
		}

		const dueAt = Date.parse(task.nextRun ?? task.dueAt);
		if (!Number.isFinite(dueAt)) return;
		const delay = Math.max(0, dueAt - Date.now());
		const timerDelay = Math.min(delay, MAX_TIMER_DELAY_MS);

		const timer = setTimeout(() => {
			handles.delete(task.id);
			if (Date.now() < dueAt) {
				scheduleTaskHandle(task, ctx);
				return;
			}
			void fireTask(task.id, ctx);
		}, timerDelay);
		handles.set(task.id, { kind: "timeout", handle: timer });
	}

	function rescheduleAll(ctx = activeCtx): void {
		if (!ctx) return;
		clearTimers();
		for (const task of core.pendingTasks(tasks)) scheduleTaskHandle(task, ctx);
		updateStatus(ctx);
		// Arm lease-expiry recovery for any persisted RUNNING task whose owner
		// may have crashed, so it is reclaimed after its lease expires (high
		// fix 2). This is bounded and non-zero: it never busy-loops.
		armLeaseRecovery(ctx);
	}

	/**
	 * Arm a single bounded lease-expiry recovery sweep. If a persisted task is
	 * RUNNING with a resolvable lease, schedule one timer to fire just past its
	 * expiry that reloads state and attempts to reclaim expired-lease tasks. A
	 * crashed owner is thus reclaimed automatically. No-op when no running task
	 * has a lease. Always uses a NON-ZERO delay (medium fix: no zero-delay
	 * infinite rearm loop).
	 */
	function armLeaseRecovery(ctx: ExtensionContext): void {
		if (isShutdown) return;
		if (recoveryTimer) {
			clearTimeout(recoveryTimer);
			recoveryTimer = undefined;
		}
		const delay = runtime.nextLeaseRecoveryDelay(tasks, new Date());
		if (delay === null) return;
		recoveryTimer = setTimeout(() => {
			recoveryTimer = undefined;
			void recoverExpiredLeases(ctx);
		}, delay);
	}

	/**
	 * Reload state, find persisted RUNNING tasks with expired leases, and
	 * reclaim them through the store so a crashed owner does not strand a task.
	 * After reclaiming, reload + reschedule so the reclaimed task's next run is
	 * armed. Guarded by the session generation so a sweep that fires after
	 * shutdown does not mutate state.
	 */
	async function recoverExpiredLeases(ctx: ExtensionContext): Promise<void> {
		if (isShutdown) return;
		const generation = sessionGeneration;
		try {
			const current = await taskStore.transaction((snapshot: any[]) =>
				snapshot.slice(),
			);
			const expired = runtime.tasksWithExpiredLeases(current, new Date());
			if (expired.length === 0) {
				if (generation === sessionGeneration && !isShutdown)
					armLeaseRecovery(ctx);
				return;
			}
			for (const task of expired) {
				// Reclaim via a targeted claim; the store recovers the expired lease.
				const claimed = await taskStore.claimDueTask({
					runnerId,
					taskId: task.id,
					now: new Date(),
					leaseMs: leaseMsForTask(task),
				});
				// We do NOT execute the reclaimed task here: an expired lease means
				// the previous owner may still be finishing. Restore it to pending
				// via abandon so the next eligible run picks it up cleanly.
				if (claimed?.claimed) {
					await safeReleaseClaim(
						claimed.task as ScheduledTask,
						claimed.claimToken,
					);
				}
			}
			if (generation === sessionGeneration && !isShutdown) {
				await reloadTasks();
				rescheduleAll(ctx);
			}
		} catch {
			// A transient store/claim failure must not strand an expired lease.
			// Reload when possible, then re-arm from the current in-memory snapshot;
			// nextLeaseRecoveryDelay applies a non-zero floor, so this retries
			// without busy-looping.
			if (generation === sessionGeneration && !isShutdown) {
				try {
					await reloadTasks();
				} catch {
					// Keep the prior snapshot; it still identifies the running lease.
				}
				armLeaseRecovery(ctx);
			}
		}
	}

	function recordMessage(
		content: string,
		details?: Record<string, any>,
		triggerTurn = false,
	): void {
		pi.sendMessage(
			{
				customType: "scheduled-task",
				content,
				display: true,
				details,
			},
			{ triggerTurn },
		);
	}

	async function executeTask(
		task: ScheduledTask,
		ctx: ExtensionContext,
	): Promise<Record<string, any>> {
		if (task.action === "notify") {
			const message = task.message ?? "Scheduled reminder";
			if (ctx.hasUI) ctx.ui.notify(message, "info");
			recordMessage(
				`🔔 ${message}`,
				{ task: runtime.redactTaskForMessage(task) },
				false,
			);
			return { ok: true, delivered: "notify" };
		}

		if (task.action === "prompt") {
			const prompt = `${scheduledPromptHeader(task)}${task.prompt}`;
			sendAgentPrompt(pi, ctx, prompt);
			return { ok: true, delivered: "prompt" };
		}

		if (task.action === "message") {
			const message = task.message ?? "Scheduled message";
			recordMessage(
				`⏰ ${message}`,
				{ task: runtime.redactTaskForMessage(task) },
				task.triggerTurn !== false,
			);
			return {
				ok: true,
				delivered: "message",
				triggerTurn: task.triggerTurn !== false,
			};
		}

		if (task.action === "shell") {
			const cwd = task.cwd || ctx.cwd;
			const timeout = task.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;

			// Revalidate the execution policy immediately before firing. The
			// policy is deny-by-default; absent/malformed config or a legacy
			// command string fails closed here. Only structured { executable,
			// argv } commands that match the allowlist are run, and they are
			// invoked DIRECTLY (no shell).
			const decision = freshPolicy().decide({ task, cwd });
			if (!decision.allowed) {
				throw new Error(
					`Scheduled shell task ${task.id} was not executed: ${decision.reason}`,
				);
			}

			if (ctx.hasUI)
				ctx.ui.notify(
					`Running scheduled executable ${decision.executable} (task ${task.id})`,
					"info",
				);

			// Use the VERIFIED REAL cwd from the policy decision (realpath-resolved),
			// never the caller-supplied path that might traverse symlinks (high fix 3).
			const execCwd = decision.cwd ?? cwd;
			const result = await pi.exec(
				decision.executable,
				decision.argv.slice(1),
				{ cwd: execCwd, timeout },
			);
			const shellResult = {
				ok: result.code === 0 && result.killed !== true,
				// Do not persist the full command text or raw output to avoid
				// leaking secrets/output into state. Keep only metadata needed
				// for wake decisions and display.
				executable: decision.executable,
				cwd: execCwd,
				timeoutMs: timeout,
				code: result.code,
				killed: result.killed,
			};

			recordMessage(
				runtime.shellCompletionMessage(task, shellResult),
				{
					task: runtime.redactTaskForMessage(task),
					result: runtime.redactResultForMessage(shellResult),
				},
				false,
			);

			if (core.shouldWakeForShellResult(task, shellResult)) {
				// stdout/stderr are passed to the in-memory follow-up prompt only,
				// never written to the persisted store.
				const transient = {
					...shellResult,
					stdout: truncateMiddle(result.stdout ?? "", MAX_PROMPT_OUTPUT_CHARS),
					stderr: truncateMiddle(result.stderr ?? "", MAX_PROMPT_OUTPUT_CHARS),
				};
				const instruction = core.selectShellFollowUpPrompt(task, shellResult);
				if (instruction)
					sendAgentPrompt(
						pi,
						ctx,
						shellResultPrompt(task, transient, instruction),
					);
			}

			return shellResult;
		}

		throw new Error(`Unsupported scheduled action: ${task.action}`);
	}

	// Bounded retry constants for the case where a one-shot timer has already
	// removed its handle but the store claim failed (lock contention / transient
	// error). Without a retry, the pending task would be stranded with no timer.
	// We retry a few times with short backoff, then fall back to rescheduling
	// the pending task (reload + rescheduleAll re-arms a timer) so the task is
	// not lost; a later tick or another runner retries the claim.
	const FIRE_CLAIM_RETRIES = 3;
	const FIRE_CLAIM_RETRY_BASE_MS = 50;
	const FIRE_CLAIM_RETRY_MAX_MS = 250;

	function sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	async function fireTask(
		taskId: string,
		ctx: ExtensionContext,
	): Promise<void> {
		// Claim the due task atomically through the store. Only the claim owner
		// (matching runnerId + claimToken) is allowed to execute and complete.
		// An expired lease (e.g. a crashed owner) is recovered by the store so a
		// new runner can reclaim it on a later tick. The `firing` guard prevents
		// the same process from racing two timers for the same task.
		if (firing.has(taskId)) return;
		// Capture the session generation at entry. If the session shuts down
		// while this task is in flight, the generation bumps and we refuse to
		// reschedule/complete after shutdown (medium fix 6).
		const generation = sessionGeneration;
		if (isShutdown) return;

		// Use the in-memory mirror to size the lease to this task's execution
		// timeout (with margin) before claiming, so a slow custom-timeout run is
		// not stolen by another runner.
		const known = tasks.find((candidate) => candidate.id === taskId);
		const leaseMs = leaseMsForTask(
			known ?? ({ timeoutMs: DEFAULT_SHELL_TIMEOUT_MS } as ScheduledTask),
		);

		// Claim with a BOUNDED retry path. A one-shot timer removes its handle
		// BEFORE calling fireTask, so if the claim throws here the pending task
		// would otherwise be stranded with no timer. Retry a few times for
		// transient lock/contention failures; if all retries fail, re-arm a
		// timer via rescheduleAll so the task is not lost.
		let claimed: any;
		let lastClaimError: any;
		for (let attempt = 0; attempt <= FIRE_CLAIM_RETRIES; attempt++) {
			try {
				claimed = await taskStore.claimDueTask({
					runnerId,
					taskId,
					now: new Date(),
					leaseMs,
				});
				lastClaimError = undefined;
				break;
			} catch (error: any) {
				lastClaimError = error;
				if (attempt >= FIRE_CLAIM_RETRIES) break;
				if (generation !== sessionGeneration || isShutdown) return;
				const backoff = Math.min(
					FIRE_CLAIM_RETRY_MAX_MS,
					FIRE_CLAIM_RETRY_BASE_MS * 2 ** attempt,
				);
				await sleep(backoff);
				if (generation !== sessionGeneration || isShutdown) return;
			}
		}

		// Shutdown may occur while claimDueTask is awaiting the store lock. Never
		// execute after the generation changes. If this runner acquired the claim
		// during that window, release it without completing or rescheduling it.
		if (generation !== sessionGeneration || isShutdown) {
			if (claimed?.claimed)
				await safeReleaseClaim(
					claimed.task as ScheduledTask,
					claimed.claimToken,
				);
			return;
		}

		if (lastClaimError) {
			// All claim attempts failed. The one-shot timer already deleted its
			// handle, so re-arm scheduling for pending tasks to avoid stranding
			// this (and any other) due task. A later tick or another runner will
			// retry the claim. Guarded by the generation so a shutdown during the
			// claim retry does not re-arm after shutdown.
			if (generation !== sessionGeneration || isShutdown) return;
			try {
				await reloadTasks();
			} catch {
				// reload is best-effort; rescheduleAll uses the in-memory mirror.
			}
			rescheduleAll(ctx);
			return;
		}
		if (!claimed?.claimed) {
			// Claim returned false (task already claimed by another runner, or not
			// due). Reload and re-arm so a crashed owner is reclaimed after its
			// lease expires (high fix 2). Use a bounded, NON-ZERO rearm so this
			// does NOT spin in a zero-delay infinite loop (claim-error retry fix).
			if (generation !== sessionGeneration || isShutdown) return;
			try {
				await reloadTasks();
			} catch {
				// reload is best-effort.
			}
			rescheduleAll(ctx);
			return;
		}

		const task = claimed.task as ScheduledTask;
		// Scope filter: only this session/cwd/global tasks fire here. If the claim
		// was for a task outside our scope, abandon the claim (restore pending,
		// no runCount bump) so the lease is cleared and the task stays pending
		// for a future eligible run — do NOT mark it fired.
		if (!taskBelongsToSession(task, ctx)) {
			await safeReleaseClaim(task, claimed.claimToken);
			return;
		}

		firing.add(task.id);
		const claimToken = claimed.claimToken;
		const claimGeneration = claimed.claimGeneration;
		try {
			updateStatus(ctx);
			const result = await executeTask(task, ctx);
			// Refuse to complete/reschedule if the session ended during execution.
			if (generation !== sessionGeneration || isShutdown) return;
			await taskStore.completeClaimedTask({
				taskId: task.id,
				runnerId,
				claimToken,
				claimGeneration,
				result,
				now: new Date(),
				ok: result.ok !== false,
			});
			await reloadTasks();
		} catch (error: any) {
			try {
				if (generation === sessionGeneration && !isShutdown) {
					await taskStore.completeClaimedTask({
						taskId: task.id,
						runnerId,
						claimToken,
						claimGeneration,
						now: new Date(),
						ok: false,
					});
					await reloadTasks();
				}
			} catch {
				// If completion fails (e.g. lease already expired and reclaimed),
				// the store's lease recovery will handle it on a later tick.
			}
			const message = `Scheduled task ${task.id} failed: ${error?.message ?? String(error)}`;
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			recordMessage(
				`⚠️ ${message}`,
				{
					task: runtime.redactTaskForMessage(task),
					error: error?.message ?? String(error),
				},
				false,
			);
		} finally {
			firing.delete(task.id);
			// Only reschedule if the session is still live (same generation). An
			// in-flight fireTask that resolves after shutdown must not re-arm
			// timers or mutate UI state.
			if (generation === sessionGeneration && !isShutdown) rescheduleAll(ctx);
		}
	}

	// Abandon a claim we should not execute (e.g. an out-of-scope task that
	// this runner claimed) WITHOUT marking it fired. Uses the store's
	// ownership/token-checked abandonClaimedTask: clears the claim metadata
	// (runnerId/claimToken/lease) and restores the task to pending so a future
	// eligible run can claim it again. runCount is NOT incremented because no
	// execution happened. Only the claim owner may abandon its own claim.
	async function safeReleaseClaim(
		task: ScheduledTask,
		claimToken: string,
	): Promise<void> {
		try {
			await taskStore.abandonClaimedTask({
				taskId: task.id,
				runnerId,
				claimToken,
				now: new Date(),
			});
			await reloadTasks();
		} catch {
			// If abandon fails (e.g. lease already expired and reclaimed by a
			// new runner that is in-scope), the store's lease recovery handles
			// it. The task is not marked fired here under any path.
		}
	}

	// Validate a shell task against the execution policy at scheduling time.
	// Legacy command strings and disallowed structured commands are rejected
	// BEFORE the task is persisted, so users learn immediately what to fix.
	function validateShellTaskAtScheduling(
		task: ScheduledTask,
		ctx: ExtensionContext,
	): void {
		if (task.action !== "shell") return;
		const cwd = task.cwd || ctx.cwd;
		const decision = freshPolicy().decide({ task, cwd });
		if (!decision.allowed) {
			const error = new Error(
				`Refused to schedule shell task: ${decision.reason}`,
			);
			throw error;
		}
	}

	async function createAndSchedule(
		input: Record<string, any>,
		ctx: ExtensionContext,
	): Promise<ScheduledTask> {
		const scope = input.scope ?? "session";
		const task = core.createScheduledTask(
			{
				...input,
				schedule: input.schedule ?? input.when ?? input.whenText,
				cwd: input.cwd ?? ctx.cwd,
				scope,
				sessionFile: scope === "session" ? currentSessionFile(ctx) : undefined,
			},
			new Date(),
		);
		// Scheduling-time policy gate: shell tasks must be authorized now so a
		// misconfigured/legacy command never reaches the store.
		validateShellTaskAtScheduling(task, ctx);

		await withTransaction((current) => {
			current.push(task);
		});
		rescheduleAll(ctx);
		return task;
	}

	function parseCommandTask(
		args: string,
		ctx: ExtensionContext,
	): Record<string, any> {
		const parsed = core.splitScheduleCommand(args, new Date());
		const base: Record<string, any> = {
			action: parsed.action,
			type: parsed.type,
			schedule: parsed.schedule,
			cwd: ctx.cwd,
		};
		if (parsed.action === "prompt") return { ...base, prompt: parsed.payload };
		if (parsed.action === "shell") return { ...base, command: parsed.payload };
		return { ...base, message: parsed.payload };
	}

	async function mutateVisibleTask(
		ctx: ExtensionContext,
		mutator: (visible: ScheduledTask[]) => ScheduledTask,
	): Promise<ScheduledTask> {
		return withTransaction((current) => {
			const visible = current.filter((task) => taskBelongsToSession(task, ctx));
			const task = mutator(visible);
			rescheduleAll(ctx);
			return task;
		});
	}

	pi.registerMessageRenderer("scheduled-task", (message, options, theme) => {
		let text = `${theme.fg("accent", theme.bold("scheduled"))} ${message.content}`;
		if (options.expanded && message.details) {
			text += `\n${theme.fg("dim", JSON.stringify(message.details, null, 2))}`;
		}
		return new Text(text, 0, 0);
	});

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		isShutdown = false;
		await reloadTasks();
		rescheduleAll(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Mark the session ended and bump the generation so any in-flight fireTask
		// or recovery sweep can detect the shutdown and refuse to reschedule or
		// mutate state after this point (medium fix 6).
		isShutdown = true;
		sessionGeneration++;
		clearTimers();
		if (recoveryTimer) {
			clearTimeout(recoveryTimer);
			recoveryTimer = undefined;
		}
		if (ctx.hasUI) {
			ctx.ui.setStatus("scheduler", undefined);
			ctx.ui.setWidget("scheduler", undefined);
		}
		activeCtx = undefined;
	});

	pi.registerCommand("schedule", {
		description: "Schedule a notify, prompt, shell command, or message action",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify(
					"Usage: /schedule [notify|prompt|shell|message] [once|every|interval|cron] <schedule> :: <payload>",
					"warning",
				);
				return;
			}
			try {
				const task = await createAndSchedule(parseCommandTask(args, ctx), ctx);
				ctx.ui.notify(taskCreatedText(task), "info");
				recordMessage(
					taskCreatedText(task),
					{ task: runtime.redactTaskForMessage(task) },
					false,
				);
			} catch (error: any) {
				ctx.ui.notify(error?.message ?? String(error), "error");
			}
		},
	});

	pi.registerCommand("remind", {
		description: "Alias for /schedule notify",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /remind <when> <message>", "warning");
				return;
			}
			try {
				const parsed = core.splitScheduleCommand(`notify ${args}`, new Date());
				const task = await createAndSchedule(
					{
						action: "notify",
						type: parsed.type,
						schedule: parsed.schedule,
						message: parsed.payload,
						cwd: ctx.cwd,
					},
					ctx,
				);
				ctx.ui.notify(taskCreatedText(task), "info");
				recordMessage(
					taskCreatedText(task),
					{ task: runtime.redactTaskForMessage(task) },
					false,
				);
			} catch (error: any) {
				ctx.ui.notify(error?.message ?? String(error), "error");
			}
		},
	});

	pi.registerCommand("schedules", {
		description:
			"List scheduled tasks; pass 'all' to include disabled/completed/cancelled/failed tasks",
		handler: async (args, ctx) => {
			await reloadTasks();
			const includeAll = args.trim().toLowerCase() === "all";
			const visible = visibleTasks(ctx);
			recordMessage(
				core.formatTaskList(visible, new Date(), { includeAll }),
				{
					includeAll,
					tasks: visible.map((t) => runtime.redactTaskForMessage(t)),
				},
				false,
			);
			updateStatus(ctx);
		},
	});

	pi.registerCommand("schedule-cancel", {
		description: "Cancel a scheduled task by id or id prefix",
		handler: async (args, ctx) => {
			const id = args.trim();
			if (!id) {
				ctx.ui.notify("Usage: /schedule-cancel <id>", "warning");
				return;
			}
			try {
				const task = await mutateVisibleTask(ctx, (visible) =>
					core.cancelScheduledTask(visible, id, new Date()),
				);
				ctx.ui.notify(`Cancelled scheduled task ${task.id}`, "info");
				recordMessage(
					`Cancelled scheduled task ${task.id}`,
					{ task: runtime.redactTaskForMessage(task) },
					false,
				);
			} catch (error: any) {
				ctx.ui.notify(error?.message ?? String(error), "error");
			}
		},
	});

	pi.registerCommand("schedule-enable", {
		description: "Enable a scheduled task by id or id prefix",
		handler: async (args, ctx) => {
			try {
				const task = await mutateVisibleTask(ctx, (visible) =>
					core.enableScheduledTask(visible, args.trim(), new Date()),
				);
				ctx.ui.notify(`Enabled scheduled task ${task.id}`, "info");
			} catch (error: any) {
				ctx.ui.notify(error?.message ?? String(error), "error");
			}
		},
	});

	pi.registerCommand("schedule-disable", {
		description: "Disable a scheduled task by id or id prefix",
		handler: async (args, ctx) => {
			try {
				const task = await mutateVisibleTask(ctx, (visible) =>
					core.disableScheduledTask(visible, args.trim(), new Date()),
				);
				ctx.ui.notify(`Disabled scheduled task ${task.id}`, "info");
			} catch (error: any) {
				ctx.ui.notify(error?.message ?? String(error), "error");
			}
		},
	});

	pi.registerCommand("schedule-remove", {
		description: "Remove a scheduled task by id or id prefix",
		handler: async (args, ctx) => {
			const id = args.trim();
			try {
				const removed = await withTransaction((current) => {
					const visible = current.filter((task) =>
						taskBelongsToSession(task, ctx),
					);
					const visibleRemoved = core.removeScheduledTask(visible, id);
					core.removeScheduledTask(current, visibleRemoved.id);
					return visibleRemoved;
				});
				clearHandle(removed.id);
				rescheduleAll(ctx);
				ctx.ui.notify(`Removed scheduled task ${removed.id}`, "info");
			} catch (error: any) {
				ctx.ui.notify(error?.message ?? String(error), "error");
			}
		},
	});

	pi.registerCommand("schedule-cleanup", {
		description:
			"Remove disabled/completed/cancelled/failed scheduled tasks visible to this session",
		handler: async (_args, ctx) => {
			const removed = await withTransaction((current) => {
				const visible = current.filter((task) =>
					taskBelongsToSession(task, ctx),
				);
				const removable = visible.filter(
					(task) =>
						task.enabled === false ||
						["fired", "cancelled", "failed"].includes(task.status),
				);
				const removableIds = new Set(removable.map((task) => task.id));
				for (let i = current.length - 1; i >= 0; i--) {
					if (removableIds.has(current[i].id)) current.splice(i, 1);
				}
				return removable;
			});
			for (const task of removed) clearHandle(task.id);
			rescheduleAll(ctx);
			ctx.ui.notify(`Cleaned up ${removed.length} scheduled task(s)`, "info");
		},
	});

	pi.registerCommand("schedule-widget", {
		description:
			"Turn the compact scheduled-actions widget on or off for this session",
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			if (value === "off" || value === "false" || value === "0")
				widgetEnabled = false;
			else if (
				value === "on" ||
				value === "true" ||
				value === "1" ||
				value === ""
			)
				widgetEnabled = true;
			else {
				ctx.ui.notify("Usage: /schedule-widget [on|off]", "warning");
				return;
			}
			updateStatus(ctx);
			ctx.ui.notify(
				`Schedule widget ${widgetEnabled ? "enabled" : "disabled"}`,
				"info",
			);
		},
	});

	pi.registerTool({
		name: "schedule_task",
		label: "Schedule Task",
		description:
			"Schedule a future or recurring action in this Pi session: notify the user, wake the agent with a prompt, run a shell command, or send a custom message.",
		promptSnippet:
			"Schedule future/recurring notify, prompt, shell, or message actions in the current Pi session",
		promptGuidelines: [
			"Use schedule_task when the user asks to do something later, when waiting on external systems such as CI/CD pipelines, or when the agent needs to wake itself up to continue work.",
			"Use schedule_task type='once' for one-shot work, type='interval' for repeated polling, and type='cron' for calendar-style schedules.",
			"Prefer schedule_task action='shell' with followUpPrompt/failurePrompt when a fixed command should run later and its output should be reviewed by the agent.",
			"For bounded polling workflows, set maxRuns so interval tasks do not run forever.",
		],
		parameters: Type.Object({
			action: StringEnum(ACTIONS, {
				description:
					"What to do at the scheduled time. Use prompt to wake the agent.",
				default: "prompt",
			}),
			type: Type.Optional(
				StringEnum(TYPES, {
					description: "Schedule type: once (default), interval, or cron.",
					default: "once",
				}),
			),
			when: Type.Optional(
				Type.String({
					description:
						"Backward-compatible alias for schedule, e.g. '5m', 'in 10 minutes', 'tomorrow at 9am'.",
				}),
			),
			schedule: Type.Optional(
				Type.String({
					description:
						"Schedule string. once: '5m'/'tomorrow at 9am'; interval: '5m'; cron: '0 */5 * * * *'.",
				}),
			),
			name: Type.Optional(
				Type.String({ description: "Optional human-readable task name." }),
			),
			description: Type.Optional(
				Type.String({ description: "Optional task description." }),
			),
			scope: Type.Optional(
				StringEnum(SCOPES, {
					description: "Task scope. Default session.",
					default: "session",
				}),
			),
			enabled: Type.Optional(
				Type.Boolean({
					description: "Whether the task starts enabled. Default true.",
				}),
			),
			maxRuns: Type.Optional(
				Type.Number({
					description:
						"Disable after this many runs. Useful for bounded polling.",
					minimum: 1,
				}),
			),
			message: Type.Optional(
				Type.String({ description: "Message for notify/message actions." }),
			),
			prompt: Type.Optional(
				Type.String({
					description: "User prompt to inject for prompt actions.",
				}),
			),
			command: Type.Optional(
				Type.Any({
					description:
						"For shell actions: a structured command { executable, argv }. Legacy command STRINGS fail closed. The command must match the user-owned scheduler-policy.json allowlist (validated when scheduling and before firing) and runs directly without a shell.",
				}),
			),
			payload: Type.Optional(
				Type.String({
					description: "Generic payload fallback for any action.",
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description:
						"Working directory for shell actions; defaults to current cwd.",
				}),
			),
			timeoutMs: Type.Optional(
				Type.Number({
					description: "Shell timeout in milliseconds.",
					minimum: 1000,
				}),
			),
			wakeOn: Type.Optional(
				StringEnum(WAKE_ON, {
					description:
						"For shell actions: when to wake the agent. Default always if a prompt is configured, otherwise never.",
				}),
			),
			followUpPrompt: Type.Optional(
				Type.String({
					description:
						"For shell actions: generic follow-up instruction sent with stdout/stderr.",
				}),
			),
			successPrompt: Type.Optional(
				Type.String({
					description:
						"For shell actions: follow-up instruction used on exit code 0.",
				}),
			),
			failurePrompt: Type.Optional(
				Type.String({
					description:
						"For shell actions: follow-up instruction used on non-zero/timeout.",
				}),
			),
			title: Type.Optional(
				Type.String({
					description: "Backward-compatible human-readable title alias.",
				}),
			),
			triggerTurn: Type.Optional(
				Type.Boolean({
					description:
						"For message actions: whether the message should trigger an agent turn. Default true.",
				}),
			),
		}),
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = args as Record<string, any>;
			if (
				input.schedule === undefined &&
				input.when === undefined &&
				typeof input.whenText === "string"
			) {
				return { ...input, when: input.whenText };
			}
			return args;
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = await createAndSchedule(params, ctx);
			return {
				content: [{ type: "text", text: taskCreatedText(task) }],
				details: {
					task: runtime.redactTaskForMessage(task),
					pending: core.pendingTasks(tasks).map(runtime.redactTaskForMessage),
				},
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("schedule_task"))} ${theme.fg("muted", args.action ?? "prompt")}/${theme.fg("muted", args.type ?? "once")} ${theme.fg("accent", args.schedule ?? args.when ?? "")}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text = result.content?.[0];
			return new Text(
				theme.fg("success", "✓ ") +
					(text?.type === "text" ? text.text : "Scheduled"),
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "list_scheduled_tasks",
		label: "List Scheduled Tasks",
		description:
			"List pending or all scheduled tasks visible to the current Pi session.",
		promptSnippet:
			"List pending/all scheduled future or recurring actions visible to the current Pi session",
		parameters: Type.Object({
			includeAll: Type.Optional(
				Type.Boolean({
					description:
						"Include disabled, fired, cancelled, and failed tasks. Default false.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await reloadTasks();
			const visible = visibleTasks(ctx);
			const text = core.formatTaskList(visible, new Date(), {
				includeAll: Boolean(params.includeAll),
			});
			updateStatus(ctx);
			return {
				content: [{ type: "text", text }],
				details: { tasks: visible.map(runtime.redactTaskForMessage) },
			};
		},
	});

	pi.registerTool({
		name: "cancel_scheduled_task",
		label: "Cancel Scheduled Task",
		description:
			"Cancel a scheduled task by id or id prefix. Alias for disabling with cancelled status.",
		promptSnippet: "Cancel a scheduled task by id or prefix",
		parameters: Type.Object({
			id: Type.String({ description: "Task id or unique id prefix." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = await mutateVisibleTask(ctx, (visible) =>
				core.cancelScheduledTask(visible, params.id, new Date()),
			);
			return {
				content: [
					{ type: "text", text: `Cancelled scheduled task ${task.id}` },
				],
				details: {
					task: runtime.redactTaskForMessage(task),
					pending: core.pendingTasks(tasks).map(runtime.redactTaskForMessage),
				},
			};
		},
	});

	pi.registerTool({
		name: "manage_scheduled_task",
		label: "Manage Scheduled Task",
		description:
			"Enable, disable, remove, update, or cleanup scheduled tasks visible to this Pi session.",
		promptSnippet:
			"Manage scheduled tasks: enable, disable, remove, update, or cleanup",
		parameters: Type.Object({
			action: StringEnum(MANAGE_ACTIONS, {
				description: "Management action to perform.",
			}),
			id: Type.Optional(
				Type.String({
					description:
						"Task id or unique id prefix. Required except for cleanup.",
				}),
			),
			name: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			type: Type.Optional(StringEnum(TYPES)),
			schedule: Type.Optional(Type.String()),
			scope: Type.Optional(StringEnum(SCOPES)),
			enabled: Type.Optional(Type.Boolean()),
			maxRuns: Type.Optional(Type.Number({ minimum: 1 })),
			prompt: Type.Optional(Type.String()),
			message: Type.Optional(Type.String()),
			command: Type.Optional(
				Type.Any({
					description:
						"For shell actions: a structured command { executable, argv }. Legacy command STRINGS fail closed. Update-time policy validation still applies: the command must match the user-owned scheduler-policy.json allowlist or the update is refused.",
				}),
			),
			timeoutMs: Type.Optional(Type.Number({ minimum: 1000 })),
			wakeOn: Type.Optional(StringEnum(WAKE_ON)),
			followUpPrompt: Type.Optional(Type.String()),
			successPrompt: Type.Optional(Type.String()),
			failurePrompt: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "cleanup") {
				const removed = await withTransaction((current) => {
					const visible = current.filter((task) =>
						taskBelongsToSession(task, ctx),
					);
					const removable = visible.filter(
						(task) =>
							task.enabled === false ||
							["fired", "cancelled", "failed"].includes(task.status),
					);
					const removableIds = new Set(removable.map((task) => task.id));
					for (let i = current.length - 1; i >= 0; i--) {
						if (removableIds.has(current[i].id)) current.splice(i, 1);
					}
					return removable;
				});
				for (const task of removed) clearHandle(task.id);
				rescheduleAll(ctx);
				return {
					content: [
						{
							type: "text",
							text: `Cleaned up ${removed.length} scheduled task(s).`,
						},
					],
					details: {
						removed: removed.map(runtime.redactTaskForMessage),
					},
				};
			}

			if (!params.id)
				throw new Error("id is required for this management action");
			const task = await withTransaction((current) => {
				const visible = current.filter((item) =>
					taskBelongsToSession(item, ctx),
				);
				let result: ScheduledTask;
				if (params.action === "enable") {
					result = core.enableScheduledTask(visible, params.id, new Date());
				} else if (params.action === "disable") {
					result = core.disableScheduledTask(visible, params.id, new Date());
				} else if (params.action === "remove") {
					const visibleRemoved = core.removeScheduledTask(visible, params.id);
					result = core.removeScheduledTask(current, visibleRemoved.id);
				} else {
					const updates = { ...params };
					delete updates.action;
					delete updates.id;
					result = core.updateScheduledTask(
						visible,
						params.id,
						updates,
						new Date(),
					);
				}
				// Re-validate a shell task after an update so the policy still
				// authorizes it (e.g. command/cwd changed).
				if (result.action === "shell")
					validateShellTaskAtScheduling(result, ctx);
				return result;
			});
			if (params.action === "remove") clearHandle(task.id);
			rescheduleAll(ctx);
			return {
				content: [
					{ type: "text", text: `${params.action} scheduled task ${task.id}` },
				],
				details: {
					task: runtime.redactTaskForMessage(task),
					pending: core.pendingTasks(tasks).map(runtime.redactTaskForMessage),
				},
			};
		},
	});
}
