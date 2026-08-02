// Contracts for completeClaimedTask lifecycle safety after lead review.
//
// High finding (1): completeClaimedTask previously made ANY failure terminal
// (status="failed", enabled=false, nextRun=undefined), even for interval/cron
// recurring tasks. Required behavior: a FAILED interval/cron task must STAY
// enabled+pending and schedule its NEXT run, unless maxRuns has been reached.
// Only `once` failures remain terminal. Successful once/maxRuns tasks stay
// terminal as before.
//
// High finding (4): cancellation/disable/removal during a RUNNING claim must
// not be undone by completion. If a task is cancelled/disabled/removed while a
// runner holds a claim and is mid-execution, the later completeClaimedTask must
// RESPECT the terminal/disabled state (a mutation-generation guard) instead of
// resurrecting the task to pending/fired.
//
// Medium finding (8): malformed persisted task state must not silently
// overwrite or crash startup. A malformed tasks.json is quarantined to a
// timestamped restrictive backup, recovery proceeds empty with a surfaced
// warning, and fail-closed behavior is preserved.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	mkdtempSync,
	rmSync,
	writeFileSync,
	readFileSync,
	readdirSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const STORE_PATH = join(
	__dirname,
	"..",
	"extensions",
	"scheduler",
	"task-store.cjs",
);
const { createTaskStore } = require(STORE_PATH);

async function withTempDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), "pi-scheduler-complete-"));
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function serializeState(tasks) {
	return `${JSON.stringify({ version: 2, updatedAt: "now", tasks })}\n`;
}

function dueTask(overrides = {}) {
	const due = new Date(Date.now() - 1000).toISOString();
	return {
		id: "t1",
		action: "notify",
		type: "once",
		status: "pending",
		enabled: true,
		scope: "cwd",
		cwd: "/tmp/project",
		schedule: "5m",
		whenText: "5m",
		createdAt: new Date().toISOString(),
		dueAt: due,
		nextRun: due,
		runCount: 0,
		message: "hi",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// High fix (1): failed recurring tasks stay enabled+pending and reschedule.
// ---------------------------------------------------------------------------

test("completeClaimedTask keeps a FAILED interval task enabled+pending with a next run", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		writeFileSync(
			file,
			serializeState([
				dueTask({
					id: "int_fail",
					type: "interval",
					schedule: "5m",
					intervalMs: 300000,
				}),
			]),
			{ mode: 0o600 },
		);
		const store = createTaskStore({ filePath: file });

		const claim = await store.claimDueTask({
			runnerId: "owner",
			now: new Date(),
			leaseMs: 60000,
		});
		assert.equal(claim.claimed, true);

		const before = Date.now();
		const failed = await store.completeClaimedTask({
			taskId: "int_fail",
			runnerId: "owner",
			claimToken: claim.claimToken,
			result: { ok: false, code: 1 },
			now: new Date(before),
			ok: false,
		});

		// Contract: a failed interval task must STAY enabled+pending and schedule
		// its next run. It must NOT be marked terminal (failed status) or disabled.
		assert.equal(failed.status, "pending", "failed interval stays pending");
		assert.equal(failed.enabled, true, "failed interval stays enabled");
		assert.equal(failed.lastStatus, "error", "failure is recorded");
		assert.equal(failed.runCount, 1, "the run counts");
		assert.ok(
			failed.nextRun,
			"failed interval must schedule its next run (not be stranded)",
		);
		const nextMs = Date.parse(failed.nextRun);
		assert.ok(
			nextMs >= before + 290000,
			`next run should be ~now+interval, got ${failed.nextRun}`,
		);
	});
});

test("completeClaimedTask keeps a FAILED cron task enabled+pending with a recomputed next run", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		writeFileSync(
			file,
			serializeState([
				dueTask({
					id: "cron_fail",
					type: "cron",
					schedule: "*/5 * * * * *",
				}),
			]),
			{ mode: 0o600 },
		);
		const store = createTaskStore({ filePath: file });

		const claim = await store.claimDueTask({
			runnerId: "owner",
			now: new Date(),
			leaseMs: 60000,
		});
		assert.equal(claim.claimed, true);

		const failed = await store.completeClaimedTask({
			taskId: "cron_fail",
			runnerId: "owner",
			claimToken: claim.claimToken,
			result: { ok: false },
			now: new Date(),
			ok: false,
		});

		assert.equal(failed.status, "pending", "failed cron stays pending");
		assert.equal(failed.enabled, true, "failed cron stays enabled");
		assert.equal(failed.lastStatus, "error");
		assert.ok(failed.nextRun, "failed cron must schedule its next run");
	});
});

test("completeClaimedTask makes a FAILED interval task terminal once maxRuns is reached", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		writeFileSync(
			file,
			serializeState([
				dueTask({
					id: "int_max",
					type: "interval",
					schedule: "5m",
					intervalMs: 300000,
					maxRuns: 1,
				}),
			]),
			{ mode: 0o600 },
		);
		const store = createTaskStore({ filePath: file });

		const claim = await store.claimDueTask({
			runnerId: "owner",
			now: new Date(),
			leaseMs: 60000,
		});
		const failed = await store.completeClaimedTask({
			taskId: "int_max",
			runnerId: "owner",
			claimToken: claim.claimToken,
			result: { ok: false },
			now: new Date(),
			ok: false,
		});

		// Once maxRuns is reached, even a recurring failure becomes terminal.
		assert.equal(failed.status, "failed");
		assert.equal(failed.enabled, false);
		assert.equal(failed.nextRun, undefined);
		assert.equal(failed.runCount, 1);
	});
});

test("completeClaimedTask makes a FAILED once task terminal (unchanged safe behavior)", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		writeFileSync(
			file,
			serializeState([dueTask({ id: "once_fail", type: "once" })]),
			{
				mode: 0o600,
			},
		);
		const store = createTaskStore({ filePath: file });

		const claim = await store.claimDueTask({
			runnerId: "owner",
			now: new Date(),
			leaseMs: 60000,
		});
		const failed = await store.completeClaimedTask({
			taskId: "once_fail",
			runnerId: "owner",
			claimToken: claim.claimToken,
			result: { ok: false },
			now: new Date(),
			ok: false,
		});

		assert.equal(failed.status, "failed", "failed once stays terminal");
		assert.equal(failed.enabled, false);
		assert.equal(failed.nextRun, undefined);
	});
});

// ---------------------------------------------------------------------------
// High fix (4): cancellation/disable/removal during a running claim must not
// be undone by completion.
// ---------------------------------------------------------------------------

test("completeClaimedTask does not resurrect a task cancelled during the run", async () => {
	// Scenario: runner claims a task and starts executing. While it runs, the
	// task is cancelled via a separate transaction (a /schedule-cancel). When
	// the runner completes the claim, completion must respect the cancelled
	// terminal state and NOT flip it back to pending/fired.
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		writeFileSync(
			file,
			serializeState([
				dueTask({ id: "cx", type: "interval", intervalMs: 300000 }),
			]),
			{ mode: 0o600 },
		);
		const store = createTaskStore({ filePath: file });

		const claim = await store.claimDueTask({
			runnerId: "owner",
			now: new Date(),
			leaseMs: 60000,
		});
		assert.equal(claim.claimed, true);

		// Cancel the task out from under the running claim.
		await store.transaction((tasks) => {
			const task = tasks.find((t) => t.id === "cx");
			task.status = "cancelled";
			task.enabled = false;
			task.cancelledAt = new Date().toISOString();
			task.nextRun = undefined;
		});

		const completed = await store.completeClaimedTask({
			taskId: "cx",
			runnerId: "owner",
			claimToken: claim.claimToken,
			result: { ok: true },
			now: new Date(),
			ok: true,
		});

		// Contract: completion must NOT undo the cancellation. The task stays
		// cancelled (terminal), is not re-enabled, and gets no next run.
		assert.equal(
			completed.status,
			"cancelled",
			"cancelled state must be preserved",
		);
		assert.equal(completed.enabled, false, "must not be re-enabled");
		assert.equal(completed.nextRun, undefined, "must not be rescheduled");
		// The run still counts (execution happened), but the terminal state wins.
		assert.ok(completed.runCount >= 1);
	});
});

test("completeClaimedTask does not resurrect a task disabled during the run", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		writeFileSync(
			file,
			serializeState([
				dueTask({ id: "dx", type: "interval", intervalMs: 300000 }),
			]),
			{ mode: 0o600 },
		);
		const store = createTaskStore({ filePath: file });

		const claim = await store.claimDueTask({
			runnerId: "owner",
			now: new Date(),
			leaseMs: 60000,
		});

		// Disable the task out from under the running claim.
		await store.transaction((tasks) => {
			const task = tasks.find((t) => t.id === "dx");
			task.enabled = false;
			task.disabledAt = new Date().toISOString();
			task.nextRun = undefined;
		});

		const completed = await store.completeClaimedTask({
			taskId: "dx",
			runnerId: "owner",
			claimToken: claim.claimToken,
			result: { ok: true },
			now: new Date(),
			ok: true,
		});

		// Contract: completion must respect the disabled state. Even a successful
		// recurring completion must NOT re-enable the task or schedule a run.
		assert.equal(completed.enabled, false, "disabled state must be preserved");
		assert.equal(completed.nextRun, undefined, "must not be rescheduled");
	});
});

// ---------------------------------------------------------------------------
// Medium fix (8): malformed task state is quarantined, not silently overwritten
// or crashing startup. Recovery proceeds empty with a surfaced warning.
// ---------------------------------------------------------------------------

test("malformed tasks.json is quarantined to a timestamped backup and recovered empty", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		// Write genuinely malformed JSON (not a valid state object).
		writeFileSync(file, "{ this is not valid json at all ]", { mode: 0o600 });

		const warnings = [];
		const store = createTaskStore({
			filePath: file,
			onWarning: (message) => warnings.push(message),
		});

		// A transaction must NOT throw on malformed state: it quarantines the bad
		// file to a timestamped restrictive backup and recovers empty.
		const result = await store.transaction((tasks) => {
			tasks.push(dueTask({ id: "fresh" }));
			return "ok";
		});
		assert.equal(result, "ok");

		// The new state file is valid and starts empty (plus our append).
		const data = JSON.parse(readFileSync(file, "utf8"));
		assert.ok(Array.isArray(data.tasks));
		assert.equal(data.tasks.length, 1);
		assert.equal(data.tasks[0].id, "fresh");

		// A timestamped quarantine backup exists alongside the state file.
		const entries = readdirSync(dir);
		const backups = entries.filter(
			(name) =>
				name.startsWith("tasks.json.malformed-") ||
				name.startsWith("tasks.json.corrupt-"),
		);
		assert.ok(
			backups.length >= 1,
			`expected a quarantine backup, got ${entries.join(", ")}`,
		);

		// A warning was surfaced so the user knows state was reset.
		assert.ok(
			warnings.length >= 1,
			"malformed state must surface a warning callback",
		);
		assert.match(warnings.join(" "), /malformed|corrupt|quarantine|recover/i);
	});
});

test("malformed-but-parseable state (no tasks array) is also quarantined", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		// Valid JSON but wrong shape (no tasks array).
		writeFileSync(file, JSON.stringify({ version: 2, oops: true }), {
			mode: 0o600,
		});

		const warnings = [];
		const store = createTaskStore({
			filePath: file,
			onWarning: (message) => warnings.push(message),
		});

		const result = await store.transaction((tasks) => {
			return tasks.length;
		});
		assert.equal(result, 0, "malformed-shape state recovers empty");

		const data = JSON.parse(readFileSync(file, "utf8"));
		assert.ok(Array.isArray(data.tasks), "state is reset to a valid shape");

		const entries = readdirSync(dir);
		const backups = entries.filter(
			(name) =>
				name.startsWith("tasks.json.malformed-") ||
				name.startsWith("tasks.json.corrupt-"),
		);
		assert.ok(backups.length >= 1, "a quarantine backup must exist");
		assert.ok(warnings.length >= 1, "a warning must be surfaced");
	});
});

test("quarantine backup is written with restrictive owner-only permissions on POSIX", async () => {
	if (typeof process.getuid !== "function" || process.platform === "win32")
		return;
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		writeFileSync(file, "not json", { mode: 0o600 });
		const store = createTaskStore({ filePath: file });
		await store.transaction((tasks) => {
			tasks.push(dueTask({ id: "x" }));
		});
		const { statSync } = require("node:fs");
		for (const name of readdirSync(dir)) {
			if (
				name.startsWith("tasks.json.malformed-") ||
				name.startsWith("tasks.json.corrupt-")
			) {
				const mode = statSync(join(dir, name)).mode & 0o777;
				assert.ok(
					mode <= 0o600,
					`quarantine backup must be owner-only, got 0o${mode.toString(8)}`,
				);
			}
		}
	});
});
