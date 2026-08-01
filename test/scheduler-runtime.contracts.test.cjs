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
