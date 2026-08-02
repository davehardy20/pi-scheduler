// Test-first safety contracts for the deny-by-default scheduled execution
// policy. These tests define the REQUIRED surface and behavior of an
// execution-policy module that does NOT yet exist. They are expected to FAIL
// for the intended reason (module not found / API missing) until step 3 of
// plan pl-9e04 lands the implementation in
// `extensions/scheduler/execution-policy.cjs`.
//
// Contracts covered:
//  - direct process execution is disabled by default
//  - legacy shell command strings fail closed (no automatic parsing)
//  - opted-in execution accepts structured argv only
//  - argv prefixes and cwd roots are validated at scheduling AND firing
//  - execution never invokes a shell / shell interpretation
//  - prompt, notify, and message tasks migrate and never auto-execute

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const POLICY_PATH = join(
	__dirname,
	"..",
	"extensions",
	"scheduler",
	"execution-policy.cjs",
);

function loadPolicy() {
	return require(POLICY_PATH);
}

// The policy now resolves cwdRoot/cwd via realpath and requires them to be
// existing directories, so policy tests use real temp dirs instead of
// synthetic paths like /repo.
function withTempDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), "pi-scheduler-policy-"));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("ExecutionPolicy module is importable", () => {
	const policy = loadPolicy();
	assert.equal(typeof policy.createExecutionPolicy, "function");
});

test("direct execution is disabled by default", () => {
	const { createExecutionPolicy } = loadPolicy();
	const policy = createExecutionPolicy(); // no config => deny by default
	const decision = policy.decide({
		task: { action: "shell", command: "echo hi" },
	});
	assert.equal(
		decision.allowed,
		false,
		"direct execution must be denied without explicit opt-in",
	);
	assert.match(
		decision.reason || "",
		/default|disabled|denied|opt-in/i,
		"denial must give actionable guidance",
	);
});

test("legacy command strings fail closed and are never silently parsed as shell", () => {
	const { createExecutionPolicy } = loadPolicy();
	// Even when explicitly enabled, a bare command STRING must be rejected —
	// the policy must never fall back to bash interpretation.
	const policy = createExecutionPolicy({
		execution: { enabled: true },
	});
	const decision = policy.decide({
		task: { action: "shell", command: "echo hello && rm -rf /" },
	});
	assert.equal(
		decision.allowed,
		false,
		"legacy command strings must fail closed",
	);
	assert.match(decision.reason || "", /legacy|command string|argv|structured/i);
});

test("opted-in execution accepts structured argv and never invokes a shell", () => {
	const { createExecutionPolicy } = loadPolicy();
	withTempDir((repo) => {
		const policy = createExecutionPolicy({
			execution: {
				enabled: true,
				allow: [{ executable: "npm", argvPrefix: ["test"], cwdRoot: repo }],
			},
		});

		const decision = policy.decide({
			task: { action: "shell", command: { executable: "npm", argv: ["test"] } },
			cwd: repo,
		});
		assert.equal(
			decision.allowed,
			true,
			"structured argv matching the allowlist must be permitted",
		);
		// Contract: when allowed, the policy returns argv to run directly — no shell.
		assert.deepEqual(decision.argv, ["npm", "test"]);
		assert.equal(decision.shell, false, "execution must never invoke a shell");
		assert.equal(decision.executable, "npm");
	});
});

test("argv prefix not in the allowlist is rejected at scheduling", () => {
	const { createExecutionPolicy } = loadPolicy();
	withTempDir((repo) => {
		const policy = createExecutionPolicy({
			execution: {
				enabled: true,
				allow: [{ executable: "npm", argvPrefix: ["test"], cwdRoot: repo }],
			},
		});
		const decision = policy.decide({
			task: {
				action: "shell",
				command: { executable: "npm", argv: ["publish"] },
			},
			cwd: repo,
		});
		assert.equal(
			decision.allowed,
			false,
			"argv not matching an allowlisted prefix must be rejected",
		);
	});
});

test("executable not in the allowlist is rejected", () => {
	const { createExecutionPolicy } = loadPolicy();
	withTempDir((repo) => {
		const policy = createExecutionPolicy({
			execution: {
				enabled: true,
				allow: [{ executable: "npm", argvPrefix: ["test"], cwdRoot: repo }],
			},
		});
		const decision = policy.decide({
			task: {
				action: "shell",
				command: { executable: "bash", argv: ["test"] },
			},
			cwd: repo,
		});
		assert.equal(
			decision.allowed,
			false,
			"non-allowlisted executables must be rejected",
		);
	});
});

test("cwd outside a configured root is rejected at firing", () => {
	const { createExecutionPolicy } = loadPolicy();
	withTempDir((repo) => {
		withTempDir((elsewhere) => {
			const policy = createExecutionPolicy({
				execution: {
					enabled: true,
					allow: [{ executable: "npm", argvPrefix: ["test"], cwdRoot: repo }],
				},
			});
			const decision = policy.decide({
				task: {
					action: "shell",
					command: { executable: "npm", argv: ["test"] },
				},
				cwd: elsewhere,
			});
			assert.equal(
				decision.allowed,
				false,
				"cwd outside a configured root must be rejected",
			);
			assert.match(decision.reason || "", /cwd|root|outside/i);
		});
	});
});

test("cwd-root validation rejects traversal escapes", () => {
	const { createExecutionPolicy } = loadPolicy();
	withTempDir((repo) => {
		const policy = createExecutionPolicy({
			execution: {
				enabled: true,
				allow: [{ executable: "npm", argvPrefix: ["test"], cwdRoot: repo }],
			},
		});
		const decision = policy.decide({
			task: { action: "shell", command: { executable: "npm", argv: ["test"] } },
			cwd: join(repo, "..", "etc"),
		});
		assert.equal(
			decision.allowed,
			false,
			"cwd traversal outside a root must be rejected",
		);
	});
});

test("argv containing shell metacharacters is treated as data, not interpreted", () => {
	const { createExecutionPolicy } = loadPolicy();
	const policy = createExecutionPolicy({
		execution: {
			enabled: true,
			allow: [{ executable: "echo", argvPrefix: [], cwdRoot: "/tmp" }],
		},
	});
	// The argv element literally contains shell syntax; because execution is
	// direct (no shell) it is safe to pass through, and argv must be returned
	// verbatim rather than tokenized/interpreted.
	const decision = policy.decide({
		task: {
			action: "shell",
			command: { executable: "echo", argv: ["a; rm -rf /"] },
		},
		cwd: "/tmp",
	});
	assert.equal(decision.allowed, true);
	assert.deepEqual(decision.argv, ["echo", "a; rm -rf /"]);
	assert.equal(decision.shell, false);
});

test("safe migration of prompt, notify, and message tasks never auto-executes", () => {
	const { migrateTask } = loadPolicy();
	const now = new Date("2026-07-05T12:00:00Z");

	const notify = migrateTask(
		{
			id: "n1",
			action: "notify",
			status: "pending",
			createdAt: now.toISOString(),
			dueAt: now.toISOString(),
			whenText: "5m",
			message: "hi",
		},
		now,
	);
	assert.equal(notify.action, "notify");
	assert.equal(
		notify.autoExecute,
		undefined,
		"migrated notify must not be marked for auto-execution",
	);

	const prompt = migrateTask(
		{
			id: "p1",
			action: "prompt",
			status: "pending",
			createdAt: now.toISOString(),
			dueAt: now.toISOString(),
			whenText: "5m",
			prompt: "summarize",
		},
		now,
	);
	assert.equal(prompt.action, "prompt");
	assert.equal(
		prompt.autoExecute,
		undefined,
		"migrated prompt must not be marked for auto-execution",
	);

	const message = migrateTask(
		{
			id: "m1",
			action: "message",
			status: "pending",
			createdAt: now.toISOString(),
			dueAt: now.toISOString(),
			whenText: "5m",
			message: "msg",
		},
		now,
	);
	assert.equal(message.action, "message");
	assert.equal(
		message.autoExecute,
		undefined,
		"migrated message must not be marked for auto-execution",
	);
});

test("a legacy persisted shell task does not become runnable through migration", () => {
	const { migrateTask } = loadPolicy();
	const now = new Date("2026-07-05T12:00:00Z");
	const migrated = migrateTask(
		{
			id: "legacy_shell",
			action: "shell",
			status: "pending",
			createdAt: now.toISOString(),
			dueAt: now.toISOString(),
			whenText: "5m",
			command: "echo legacy && date",
		},
		now,
	);
	// A legacy command string must be preserved for display but flagged as
	// non-executable until the user re-creates it with structured argv.
	assert.equal(migrated.command, "echo legacy && date");
	assert.equal(
		migrated.autoExecute,
		false,
		"legacy shell command strings must never auto-execute after migration",
	);
});
