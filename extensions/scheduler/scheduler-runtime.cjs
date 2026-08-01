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
 * @param {Array} tasks
 * @param {Date} now
 * @param {object} [options]
 * @returns {number|null}
 */
function nextLeaseRecoveryDelay(tasks, now = new Date(), options = {}) {
	const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
	if (!Number.isFinite(nowMs)) return null;
	const minDelayMs = Math.max(1, Number(options.minDelayMs ?? 1000));
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
	// earliest lease is far in the future, wait until just past it.
	return Math.max(minDelayMs, raw + 1);
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

module.exports = {
	tasksWithExpiredLeases,
	nextLeaseRecoveryDelay,
	claimFalseRearmDelay,
	redactTaskForMessage,
	redactResultForMessage,
	shellCompletionMessage,
	renderCommand,
};
