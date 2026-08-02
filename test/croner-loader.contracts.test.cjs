"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, rmSync, symlinkSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");

test("cron completion resolves croner through a preserved package symlink", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pi-scheduler-croner-loader-"));
	try {
		const linkedScheduler = join(
			tmp,
			"node_modules",
			"@jl1990",
			"pi-scheduler",
			"extensions",
			"scheduler",
		);
		mkdirSync(dirname(linkedScheduler), { recursive: true });
		symlinkSync(
			resolve(__dirname, "..", "extensions", "scheduler"),
			linkedScheduler,
			"dir",
		);
		const linkedCore = join(linkedScheduler, "scheduler-core.cjs");
		const linkedStore = join(linkedScheduler, "task-store.cjs");
		const stateFile = join(tmp, "tasks.json");
		const script = [
			`const fs = require("node:fs");`,
			`const core = require(${JSON.stringify(linkedCore)});`,
			`const { createTaskStore } = require(${JSON.stringify(linkedStore)});`,
			`const now = new Date("2026-07-05T12:00:00Z");`,
			`const task = { id: "cron_1", action: "notify", type: "cron", status: "pending", enabled: true, scope: "global", schedule: "0 */5 * * * *", whenText: "0 */5 * * * *", createdAt: now.toISOString(), dueAt: new Date(now.getTime() - 1000).toISOString(), nextRun: new Date(now.getTime() - 1000).toISOString(), runCount: 0, message: "hi" };`,
			`fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify({ version: 2, updatedAt: "now", tasks: [task] }) + "\\n", { mode: 0o600 });`,
			`void (async () => {`,
			`  const parsed = core.validateTaskSchedule("cron", task.schedule, now);`,
			`  const store = createTaskStore({ filePath: ${JSON.stringify(stateFile)} });`,
			`  const claim = await store.claimDueTask({ runnerId: "runner", taskId: task.id, now, leaseMs: 60000 });`,
			`  const completed = await store.completeClaimedTask({ taskId: task.id, runnerId: "runner", claimToken: claim.claimToken, claimGeneration: claim.claimGeneration, result: { ok: true }, ok: true, now });`,
			`  console.log(JSON.stringify({ parsed: parsed.type, status: completed.status, nextRun: completed.nextRun }));`,
			`})().catch((error) => { console.error(error); process.exitCode = 1; });`,
		].join("\n");
		const result = spawnSync(
			process.execPath,
			["--preserve-symlinks", "-e", script],
			{ encoding: "utf8" },
		);

		assert.equal(result.status, 0, result.stderr || result.stdout);
		const output = JSON.parse(result.stdout.trim());
		assert.equal(output.parsed, "cron");
		assert.equal(output.status, "pending");
		assert.ok(Date.parse(output.nextRun) > Date.parse("2026-07-05T12:00:00Z"));
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});
