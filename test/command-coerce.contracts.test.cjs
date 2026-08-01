// Contracts for structured-command coercion used by updateScheduledTask.
//
// Lead review found that manage_scheduled_task declared `command` as
// Type.String even though shell commands are STRUCTURED ({ executable, argv }).
// The core updateScheduledTask ran the value through compactSpaces(), which
// would stringify a structured command into "[object Object]".
//
// These tests pin the REQUIRED behavior introduced for Seeds child
// pi-scheduler-6392:
//
//   * a structured { executable, argv } command survives updateScheduledTask
//     intact (not stringified) so update-time policy validation can authorize
//     it.
//   * a legacy string command is still accepted for display/back-compat.
//   * malformed structured shapes (non-array argv, non-string executable,
//     NUL bytes) throw so callers learn immediately.
//   * the manage_scheduled_task command schema is structured-compatible
//     (the schema change is asserted indirectly via the core coercion used by
//     the update path).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
	updateScheduledTask,
	createScheduledTask,
	coerceCommand,
} = require("../extensions/scheduler/scheduler-core.cjs");

const NOW = new Date(2026, 6, 5, 12, 0, 0, 0);

test("coerceCommand passes a structured { executable, argv } command through verbatim", () => {
	const out = coerceCommand({ executable: "npm", argv: ["test", "--silent"] });
	assert.deepEqual(out, { executable: "npm", argv: ["test", "--silent"] });
});

test("coerceCommand trims a legacy string command for display/back-comat", () => {
	assert.equal(coerceCommand("  npm test  "), "npm test");
});

test("coerceCommand rejects malformed structured shapes", () => {
	assert.throws(
		() => coerceCommand({ executable: 123, argv: [] }),
		/executable/,
	);
	assert.throws(
		() => coerceCommand({ executable: "  ", argv: [] }),
		/executable/,
	);
	assert.throws(
		() => coerceCommand({ executable: "npm", argv: "test" }),
		/argv/,
	);
	assert.throws(
		() => coerceCommand({ executable: "npm", argv: [123] }),
		/argv/,
	);
	assert.throws(
		() => coerceCommand({ executable: "npm", argv: ["a\u0000b"] }),
		/argv/,
	);
	assert.throws(() => coerceCommand(12345), /command must be/);
});

test("coerceCommand accepts a structured command with no argv", () => {
	assert.deepEqual(coerceCommand({ executable: "date" }), {
		executable: "date",
		argv: [],
	});
});

test("updateScheduledTask preserves a structured command instead of stringifying it", () => {
	// Start from a task with a structured command (as created by schedule_task).
	const tasks = [
		createScheduledTask(
			{
				action: "shell",
				type: "interval",
				schedule: "5m",
				command: { executable: "npm", argv: ["test"] },
				cwd: "/repo",
			},
			NOW,
			() => "shell_struct",
		),
	];

	const updated = updateScheduledTask(
		tasks,
		"shell_struct",
		{ command: { executable: "npm", argv: ["run", "build"] } },
		NOW,
	);

	// Contract: the structured command survives the update intact — it must NOT
	// be stringified to "[object Object]".
	assert.deepEqual(updated.command, {
		executable: "npm",
		argv: ["run", "build"],
	});
});

test("updateScheduledTask still accepts a legacy string command (display-only)", () => {
	const tasks = [
		createScheduledTask(
			{
				action: "shell",
				type: "interval",
				schedule: "5m",
				command: "npm test",
				cwd: "/repo",
			},
			NOW,
			() => "shell_legacy",
		),
	];
	const updated = updateScheduledTask(
		tasks,
		"shell_legacy",
		{ command: "echo hi" },
		NOW,
	);
	assert.equal(updated.command, "echo hi");
});

test("updateScheduledTask throws on a malformed structured command update", () => {
	const tasks = [
		createScheduledTask(
			{
				action: "shell",
				type: "interval",
				schedule: "5m",
				command: "npm test",
				cwd: "/repo",
			},
			NOW,
			() => "shell_bad",
		),
	];
	assert.throws(
		() =>
			updateScheduledTask(
				tasks,
				"shell_bad",
				{ command: { executable: "npm", argv: "not-array" } },
				NOW,
			),
		/argv/,
	);
});

test("updateScheduledTask preserves an existing structured command when command is not updated", () => {
	const tasks = [
		createScheduledTask(
			{
				action: "shell",
				type: "interval",
				schedule: "5m",
				command: { executable: "npm", argv: ["test"] },
				cwd: "/repo",
			},
			NOW,
			() => "shell_keep",
		),
	];
	const updated = updateScheduledTask(
		tasks,
		"shell_keep",
		{ name: "renamed" },
		NOW,
	);
	assert.deepEqual(updated.command, { executable: "npm", argv: ["test"] });
	assert.equal(updated.name, "renamed");
});
