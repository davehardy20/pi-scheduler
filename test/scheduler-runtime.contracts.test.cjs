// Contracts for the scheduler runtime helper module (high fix 2: lease-expiry
// recovery + claim-false rearm; medium fix 7: message-detail redaction + sane
// structured-command rendering).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");

const RUNTIME_PATH = join(
	__dirname,
	"..",
	"extensions",
	"scheduler",
	"scheduler-runtime.cjs",
);
const {
	tasksWithExpiredLeases,
	nextLeaseRecoveryDelay,
	claimFalseRearmDelay,
	redactTaskForMessage,
	redactResultForMessage,
	shellCompletionMessage,
	renderCommand,
	runClaimedExecution,
} = require(RUNTIME_PATH);

const NOW = new Date("2026-07-05T12:00:00Z");

function runningTask(overrides = {}) {
	return {
		id: "r1",
		action: "notify",
		type: "once",
		status: "running",
		enabled: true,
		claimLeaseExpiresAt: new Date(NOW.getTime() - 60000).toISOString(),
		message: "hi",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Lease-expiry recovery: persisted RUNNING tasks with expired leases are
// detected so a crashed owner does not strand a task.
// ---------------------------------------------------------------------------

test("tasksWithExpiredLeases finds running tasks whose lease has expired", () => {
	const tasks = [
		runningTask({ id: "expired" }), // expired lease
		runningTask({
			id: "live",
			claimLeaseExpiresAt: new Date(NOW.getTime() + 60000).toISOString(),
		}),
		{ id: "pending", status: "pending" },
	];
	const expired = tasksWithExpiredLeases(tasks, NOW);
	assert.deepEqual(
		expired.map((t) => t.id),
		["expired"],
	);
});

test("tasksWithExpiredLeases ignores non-running tasks even with a past lease", () => {
	const tasks = [
		{
			id: "fired",
			status: "fired",
			claimLeaseExpiresAt: "2000-01-01T00:00:00Z",
		},
		{
			id: "pending",
			status: "pending",
			claimLeaseExpiresAt: "2000-01-01T00:00:00Z",
		},
	];
	assert.deepEqual(tasksWithExpiredLeases(tasks, NOW), []);
});

test("nextLeaseRecoveryDelay arms a bounded non-zero delay until the next expiry", () => {
	const expires = new Date(NOW.getTime() + 30000).toISOString();
	const tasks = [runningTask({ id: "future", claimLeaseExpiresAt: expires })];
	const delay = nextLeaseRecoveryDelay(tasks, NOW);
	assert.ok(delay !== null, "a running task must schedule recovery");
	assert.ok(delay >= 1, "recovery delay must be non-zero");
	// Recovery is armed just past expiry, with a minimum floor.
	assert.ok(delay >= 30000 && delay <= 30001 + 1000);
});

test("nextLeaseRecoveryDelay floors an already-expired lease to avoid a spin", () => {
	const tasks = [runningTask({ id: "expired" })]; // expired 60s ago
	const delay = nextLeaseRecoveryDelay(tasks, NOW);
	assert.ok(delay !== null);
	assert.ok(
		delay >= 1000,
		"expired lease must still wait the min floor, not spin",
	);
});

test("nextLeaseRecoveryDelay returns null when no running task has a lease", () => {
	assert.equal(nextLeaseRecoveryDelay([], NOW), null);
	assert.equal(
		nextLeaseRecoveryDelay([{ id: "p", status: "pending" }], NOW),
		null,
	);
});

test("nextLeaseRecoveryDelay caps a far-future lease at the supplied maxDelayMs", () => {
	// A lease far beyond Node's setTimeout max (~24.8 days) MUST be capped so
	// the recovery timer does not fire immediately (Node clamps an over-max
	// delay to ~1ms, which would busy-loop recovery). The cap lets the expiry
	// callback re-arm against the absolute expiry once it fires.
	const MAX = 2_147_483_647; // Node setTimeout practical max
	const farFuture = new Date(NOW.getTime() + 90 * 24 * 3600_000).toISOString(); // ~90 days
	const tasks = [runningTask({ id: "far", claimLeaseExpiresAt: farFuture })];
	const delay = nextLeaseRecoveryDelay(tasks, NOW, { maxDelayMs: MAX });
	assert.ok(delay !== null, "a far-future lease must still schedule recovery");
	assert.ok(
		delay <= MAX,
		`far-future recovery delay must be capped at maxDelayMs, got ${delay}`,
	);
	assert.ok(delay >= 1, "capped recovery delay must stay non-zero");
});

test("nextLeaseRecoveryDelay caps consistently regardless of how far out the lease is", () => {
	const MAX = 2_147_483_647;
	const near = new Date(NOW.getTime() + 10_000).toISOString();
	const far = new Date(NOW.getTime() + 365 * 24 * 3600_000).toISOString();
	const nearDelay = nextLeaseRecoveryDelay(
		[runningTask({ id: "near", claimLeaseExpiresAt: near })],
		NOW,
		{ maxDelayMs: MAX },
	);
	const farDelay = nextLeaseRecoveryDelay(
		[runningTask({ id: "far", claimLeaseExpiresAt: far })],
		NOW,
		{ maxDelayMs: MAX },
	);
	// A near lease stays under the cap (arms just past expiry); a far lease is
	// clamped exactly to the cap.
	assert.ok(nearDelay !== null && nearDelay <= MAX);
	assert.equal(farDelay, MAX);
});

test("nextLeaseRecoveryDelay maxDelayMs validation mirrors minDelayMs (finite, >=1)", () => {
	const expires = new Date(NOW.getTime() + 90 * 24 * 3600_000).toISOString();
	const tasks = [runningTask({ id: "far", claimLeaseExpiresAt: expires })];
	// A non-finite maxDelayMs is ignored (treated as unset), so the raw delay is
	// returned uncapped — mirroring how minDelayMs falls back to its default.
	assert.ok(
		nextLeaseRecoveryDelay(tasks, NOW, { maxDelayMs: Number.NaN }) >
			2_147_483_647,
	);
	// A maxDelayMs below the min floor would clamp to below minDelayMs; ensure
	// the floor still wins so recovery never spins below minDelayMs.
	const floored = nextLeaseRecoveryDelay(tasks, NOW, {
		maxDelayMs: 0,
		minDelayMs: 1000,
	});
	assert.ok(floored >= 1000, "minDelayMs floor must still apply");
});

// ---------------------------------------------------------------------------
// Claim-false rearm: a bounded, NON-ZERO delay so a crashed owner is reclaimed
// after expiry without a zero-delay infinite loop.
// ---------------------------------------------------------------------------

test("claimFalseRearmDelay is always non-zero and bounded", () => {
	for (let i = 0; i < 20; i++) {
		const delay = claimFalseRearmDelay(i);
		assert.ok(delay >= 1, `attempt ${i} must be non-zero, got ${delay}`);
		assert.ok(delay <= 2000, `attempt ${i} must be bounded, got ${delay}`);
	}
});

test("claimFalseRearmDelay grows with attempts up to the cap", () => {
	const first = claimFalseRearmDelay(0);
	const later = claimFalseRearmDelay(5);
	assert.ok(later >= first, "rearm delay should not shrink with attempts");
	assert.ok(claimFalseRearmDelay(100) <= 2000, "rearm delay is capped");
});

// ---------------------------------------------------------------------------
// Message-detail redaction: shell command argv and prompt/message text are
// stripped; only safe identifiers/metadata remain.
// ---------------------------------------------------------------------------

test("redactTaskForMessage keeps safe identifiers and drops prompt/message text", () => {
	const redacted = redactTaskForMessage({
		id: "t1",
		action: "prompt",
		type: "once",
		status: "pending",
		enabled: true,
		scope: "session",
		schedule: "5m",
		name: "wake",
		runCount: 0,
		nextRun: "2026-07-05T12:05:00Z",
		prompt: "SECRET follow-up instruction",
		message: "SECRET message",
	});
	assert.equal(redacted.id, "t1");
	assert.equal(redacted.action, "prompt");
	assert.equal(redacted.prompt, undefined, "prompt text must be redacted");
	assert.equal(redacted.message, undefined, "message text must be redacted");
});

test("redactTaskForMessage keeps only the executable for shell tasks, not argv", () => {
	const redacted = redactTaskForMessage({
		id: "s1",
		action: "shell",
		type: "interval",
		status: "pending",
		command: { executable: "npm", argv: ["test", "--token=SECRET"] },
	});
	assert.equal(redacted.executable, "npm");
	assert.equal(
		redacted.command,
		undefined,
		"the raw command object must not be surfaced",
	);
	assert.equal(redacted.argv, undefined, "argv must be redacted");
});

test("redactTaskForMessage flags a legacy string command without surfacing text", () => {
	const redacted = redactTaskForMessage({
		id: "l1",
		action: "shell",
		command: "echo SECRET && rm -rf /",
	});
	assert.equal(redacted.legacyCommand, true);
	assert.equal(redacted.command, undefined);
});

test("redactResultForMessage keeps exit metadata and drops stdout/stderr", () => {
	const redacted = redactResultForMessage({
		ok: false,
		executable: "npm",
		cwd: "/repo",
		code: 1,
		killed: false,
		stdout: "SECRET output",
		stderr: "SECRET error",
	});
	assert.equal(redacted.code, 1);
	assert.equal(redacted.killed, false);
	assert.equal(redacted.executable, "npm");
	assert.equal(redacted.stdout, undefined, "stdout must be redacted");
	assert.equal(redacted.stderr, undefined, "stderr must be redacted");
});

test("shell completion message excludes argv and raw output", () => {
	const message = shellCompletionMessage(
		{
			id: "s1",
			command: { executable: "npm", argv: ["test", "--token=SECRET"] },
		},
		{
			executable: "npm",
			code: 1,
			stdout: "SECRET output",
			stderr: "SECRET error",
		},
	);
	assert.equal(
		message,
		"🖥️ Scheduled command s1 (npm) finished with exit code 1",
	);
	assert.doesNotMatch(message, /SECRET|--token|stdout|stderr/);
});

// ---------------------------------------------------------------------------
// Structured command rendering: never stringifies to "[object Object]".
// ---------------------------------------------------------------------------

test("renderCommand renders a structured command readably", () => {
	assert.equal(
		renderCommand({ executable: "npm", argv: ["test", "--silent"] }),
		"npm test --silent",
	);
});

test("renderCommand renders a legacy string command as-is", () => {
	assert.equal(renderCommand("npm test"), "npm test");
});

test("renderCommand handles missing/odd shapes without [object Object]", () => {
	assert.equal(renderCommand(undefined), "(no command)");
	assert.equal(renderCommand({}), "(no executable)");
	assert.equal(renderCommand({ executable: "date" }), "date");
});

// ---------------------------------------------------------------------------
// LOW fix: defensive delay validation. minDelayMs must be a finite number >= 1
// (else fall back to 1000), and an effective maxDelayMs must never drop the
// result below minDelayMs. This keeps recovery from busy-looping below the
// min floor even when a caller supplies a malformed maxDelayMs.
// ---------------------------------------------------------------------------

test("nextLeaseRecoveryDelay treats a NaN minDelayMs as the 1000 default", () => {
	const tasks = [runningTask({ id: "expired" })]; // expired 60s ago
	const delay = nextLeaseRecoveryDelay(tasks, NOW, { minDelayMs: Number.NaN });
	assert.ok(delay !== null);
	assert.ok(
		delay >= 1000,
		"NaN minDelayMs must fall back to the default floor, not produce NaN",
	);
});

test("nextLeaseRecoveryDelay keeps the min floor when maxDelayMs < minDelayMs", () => {
	const tasks = [runningTask({ id: "expired" })]; // expired 60s ago
	const delay = nextLeaseRecoveryDelay(tasks, NOW, {
		minDelayMs: 1000,
		maxDelayMs: 1,
	});
	assert.ok(delay !== null);
	assert.ok(
		delay >= 1000,
		"effective maxDelayMs must never drop the result below minDelayMs",
	);
});

test("nextLeaseRecoveryDelay rejects non-finite/negative minDelayMs values", () => {
	const tasks = [runningTask({ id: "expired" })];
	for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5, 0]) {
		const delay = nextLeaseRecoveryDelay(tasks, NOW, { minDelayMs: bad });
		assert.ok(
			Number.isFinite(delay) && delay >= 1000,
			`minDelayMs=${bad} must fall back to 1000, got ${delay}`,
		);
	}
});

// ---------------------------------------------------------------------------
// HIGH fix + MEDIUM fix: runClaimedExecution behavioral contract.
//
// runClaimedExecution isolates the policy concerns of a claimed task's
// fire-time settle:
//   * Only an execute() REJECTION may persist ok:false.
//   * After execute() returns a result, completion is always attempted
//     regardless of liveness; a success/result completion error must NEVER be
//     downgraded to ok:false (it reports persistence failure if live, only).
//   * reload() and failure/persistence reports are gated on isLive().
//   * reload failure after durable success never reports task-failed.
//
// These are pure behavioral tests using injected fakes (no Pi process, no
// source-regex matching).
// ---------------------------------------------------------------------------

function makeFakes() {
	return {
		calls: {
			complete: [],
			reload: 0,
			reportTaskFailure: [],
			reportPersistenceFailure: [],
		},
	};
}

function fakeExecute(value) {
	const fn = async () => value;
	fn.label = "execute";
	return fn;
}

async function rejectedExecute(reason) {
	throw new Error(reason);
}

function recordCall(arr, payload) {
	arr.push(payload);
}

function fakesWithDeps(extra = {}) {
	const f = makeFakes();
	// The default complete records the payload. A throwing variant records FIRST
	// then throws, so completion-throws tests can still assert the attempted
	// payload was the success completion (never ok:false).
	const makeComplete = (shouldThrow) => async (payload) => {
		recordCall(f.calls.complete, payload);
		if (shouldThrow) throw new Error("completion store write failed");
	};
	const deps = {
		execute: extra.execute ?? fakeExecute({ ok: true, delivered: "notify" }),
		complete: makeComplete(extra.completeThrows === true),
		reload: async () => {
			f.calls.reload += 1;
			if (extra.reloadThrows) throw new Error("reload store read failed");
		},
		isLive: extra.isLive ?? (() => true),
		...(extra.shouldReload ? { shouldReload: extra.shouldReload } : {}),
		reportTaskFailure: (error, task) =>
			recordCall(f.calls.reportTaskFailure, {
				error: error?.message ?? String(error),
				task,
			}),
		reportPersistenceFailure: (error, task, result) =>
			recordCall(f.calls.reportPersistenceFailure, {
				error: error?.message ?? String(error),
				task,
				result,
			}),
	};
	return { f, deps };
}

const CLAIM = {
	taskId: "t1",
	runnerId: "owner",
	claimToken: "tok",
	claimGeneration: 3,
};
const TASK = { id: "t1", action: "notify", type: "once", message: "hi" };

test("runClaimedExecution: success persists result and performs no live side effects when not live", async () => {
	const { f, deps } = fakesWithDeps({
		isLive: () => false,
		execute: fakeExecute({ ok: true, delivered: "notify" }),
	});
	await runClaimedExecution(TASK, CLAIM, deps);
	// The result is persisted regardless of liveness (durable completion).
	assert.equal(f.calls.complete.length, 1);
	assert.deepEqual(f.calls.complete[0], {
		result: { ok: true, delivered: "notify" },
		ok: true,
	});
	// Not live: no reload, no failure/persistence reports.
	assert.equal(f.calls.reload, 0, "reload must be skipped when not live");
	assert.equal(f.calls.reportTaskFailure.length, 0);
	assert.equal(f.calls.reportPersistenceFailure.length, 0);
});

test("runClaimedExecution: successor session reloads an older generation's durable completion", async () => {
	const { f, deps } = fakesWithDeps({
		isLive: () => false,
		shouldReload: () => true,
		execute: fakeExecute({ ok: true, delivered: "notify" }),
	});
	await runClaimedExecution(TASK, CLAIM, deps);
	assert.equal(f.calls.complete.length, 1);
	assert.equal(
		f.calls.reload,
		1,
		"the active successor must refresh persisted state",
	);
	assert.equal(f.calls.reportTaskFailure.length, 0);
	assert.equal(f.calls.reportPersistenceFailure.length, 0);
});

test("runClaimedExecution: successor reloads an older generation's durable failure", async () => {
	const { f, deps } = fakesWithDeps({
		isLive: () => false,
		shouldReload: () => true,
		execute: async () => rejectedExecute("policy refused"),
	});
	await runClaimedExecution(TASK, CLAIM, deps);
	assert.deepEqual(f.calls.complete, [{ result: undefined, ok: false }]);
	assert.equal(f.calls.reload, 1);
	assert.equal(f.calls.reportTaskFailure.length, 0);
	assert.equal(f.calls.reportPersistenceFailure.length, 0);
});

test("runClaimedExecution: execute rejection persists ok:false and performs no live side effects when not live", async () => {
	const { f, deps } = fakesWithDeps({
		isLive: () => false,
		execute: async () => rejectedExecute("policy refused"),
	});
	await runClaimedExecution(TASK, CLAIM, deps);
	assert.equal(f.calls.complete.length, 1);
	assert.deepEqual(f.calls.complete[0], { result: undefined, ok: false });
	// Not live: no live-session side effects even though execute rejected.
	assert.equal(f.calls.reload, 0);
	assert.equal(
		f.calls.reportTaskFailure.length,
		0,
		"failure report is live-gated",
	);
	assert.equal(f.calls.reportPersistenceFailure.length, 0);
});

test("runClaimedExecution: success completion that throws is never followed by ok:false", async () => {
	// A returned result whose completion THROWS must not be downgraded to a
	// ok:false. Instead it reports a PERSISTENCE failure (if live) and leaves
	// completion untouched.
	const { f, deps } = fakesWithDeps({
		isLive: () => true,
		execute: fakeExecute({ ok: true, delivered: "notify" }),
		completeThrows: true,
	});
	await runClaimedExecution(TASK, CLAIM, deps);
	assert.equal(
		f.calls.complete.length,
		1,
		"completion must be attempted exactly once",
	);
	assert.deepEqual(
		f.calls.complete[0],
		{ result: { ok: true, delivered: "notify" }, ok: true },
		"only the success completion must be attempted; no ok:false downgrade",
	);
	assert.equal(
		f.calls.reportPersistenceFailure.length,
		1,
		"a success-completion failure must report persistence failure (live)",
	);
	assert.equal(
		f.calls.reportTaskFailure.length,
		0,
		"a success-completion failure must NOT be reported as a task failure",
	);
});

test("runClaimedExecution: success completion throws when not live reports no task failure and no persistence report", async () => {
	// Not live + success completion throws: persist failure is silent (no live
	// session to report to), still no ok:false downgrade.
	const { f, deps } = fakesWithDeps({
		isLive: () => false,
		execute: fakeExecute({ ok: true, delivered: "notify" }),
		completeThrows: true,
	});
	await runClaimedExecution(TASK, CLAIM, deps);
	assert.deepEqual(
		f.calls.complete[0],
		{ result: { ok: true, delivered: "notify" }, ok: true },
		"no ok:false downgrade",
	);
	assert.equal(
		f.calls.reportPersistenceFailure.length,
		0,
		"not live: no persistence report",
	);
	assert.equal(f.calls.reportTaskFailure.length, 0, "no task failure either");
});

test("runClaimedExecution: reload throws after durable success does not report task failure", async () => {
	// Completion succeeds (durable), then reload THROWS. This must never emit a
	// task-failed report/UI; reload is best-effort.
	const { f, deps } = fakesWithDeps({
		isLive: () => true,
		execute: fakeExecute({ ok: true, delivered: "notify" }),
		reloadThrows: true,
	});
	await runClaimedExecution(TASK, CLAIM, deps);
	assert.equal(f.calls.complete.length, 1);
	assert.equal(
		f.calls.reportTaskFailure.length,
		0,
		"reload failure after durable success must not be reported as task failure",
	);
	assert.equal(f.calls.reportPersistenceFailure.length, 0);
});

test("runClaimedExecution: execute rejection always attempts ok:false even when not live", async () => {
	// Regression: a rejection MUST persist ok:false regardless of liveness so
	// lease recovery does not re-execute the task.
	const { f, deps } = fakesWithDeps({
		isLive: () => false,
		execute: async () => rejectedExecute("exec boom"),
	});
	await runClaimedExecution(TASK, CLAIM, deps);
	assert.deepEqual(f.calls.complete[0], { result: undefined, ok: false });
	assert.equal(
		f.calls.reportTaskFailure.length,
		0,
		"not live: no task failure report",
	);
});

test("runClaimedExecution: execute rejection when live reports task failure and reloads", async () => {
	const { f, deps } = fakesWithDeps({
		isLive: () => true,
		execute: async () => rejectedExecute("exec boom"),
	});
	await runClaimedExecution(TASK, CLAIM, deps);
	assert.deepEqual(f.calls.complete[0], { result: undefined, ok: false });
	assert.equal(
		f.calls.reportTaskFailure.length,
		1,
		"live rejection reports task failure",
	);
	assert.equal(f.calls.reload, 1, "live rejection reloads after reporting");
	assert.equal(f.calls.reportPersistenceFailure.length, 0);
});

test("runClaimedExecution: failed completion errors do not suppress the task failure report", async () => {
	const { f, deps } = fakesWithDeps({
		isLive: () => true,
		execute: async () => rejectedExecute("exec boom"),
		completeThrows: true,
	});
	await assert.doesNotReject(() => runClaimedExecution(TASK, CLAIM, deps));
	assert.deepEqual(f.calls.complete, [{ result: undefined, ok: false }]);
	assert.equal(f.calls.reload, 0, "reload requires durable completion");
	assert.equal(f.calls.reportTaskFailure.length, 1);
	assert.equal(
		f.calls.reportPersistenceFailure.length,
		1,
		"failed-outcome persistence errors remain visible while live",
	);
});
