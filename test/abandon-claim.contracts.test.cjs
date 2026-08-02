// Contracts for the ownership/token-checked claim abandonment path.
//
// Lead review found that the first integration pass completed an out-of-scope
// once task as FIRED even though it should have remained PENDING, because the
// release path reused completeClaimedTask({ ok: true }). That marks a once
// task as fired (terminal) and bumps runCount.
//
// These tests pin the REQUIRED behavior introduced for Seeds child
// pi-scheduler-6392:
//
//   * abandonClaimedTask clears claim metadata and restores the task to
//     pending WITHOUT incrementing runCount (no execution happened).
//   * only the claim owner (matching runnerId AND claimToken) may abandon.
//   * an abandoned once task stays pending and re-runnable (runCount 0).
//   * an abandoned interval task has its nextRun recomputed from now so it
//     does not re-fire on the same tick.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const ROOT = join(__dirname, "..", "extensions", "scheduler");
const { createTaskStore } = require(join(ROOT, "task-store.cjs"));

async function withTempDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), "pi-scheduler-abandon-"));
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
		id: "abandon_me",
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

test("abandonClaimedTask restores a once task to pending without bumping runCount", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		writeFileSync(file, serializeState([dueTask({ type: "once" })]), {
			mode: 0o600,
		});
		const store = createTaskStore({ filePath: file });

		const claim = await store.claimDueTask({
			runnerId: "owner",
			now: new Date(),
			leaseMs: 60000,
		});
		assert.equal(claim.claimed, true);
		assert.equal(claim.task.status, "running");

		const abandoned = await store.abandonClaimedTask({
			taskId: "abandon_me",
			runnerId: "owner",
			claimToken: claim.claimToken,
			now: new Date(),
		});

		// Contract: the task is PENDING again, runCount is UNCHANGED (0), and the
		// claim metadata is cleared so a future eligible runner can reclaim it.
		assert.equal(abandoned.status, "pending");
		assert.equal(
			abandoned.runCount,
			0,
			"runCount must not increment on abandon",
		);
		assert.equal(abandoned.claimToken, undefined);
		assert.equal(abandoned.runnerId, undefined);
		assert.equal(abandoned.claimLeaseExpiresAt, undefined);
		// A once task keeps its dueAt/nextRun so the next eligible runner can fire.
		assert.ok(abandoned.nextRun || abandoned.dueAt);
	});
});

test("abandonClaimedTask is re-runnable: an abandoned once task can be claimed again", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		writeFileSync(file, serializeState([dueTask({ type: "once" })]), {
			mode: 0o600,
		});
		const store = createTaskStore({ filePath: file });

		const first = await store.claimDueTask({
			runnerId: "owner",
			now: new Date(),
			leaseMs: 60000,
		});
		await store.abandonClaimedTask({
			taskId: "abandon_me",
			runnerId: "owner",
			claimToken: first.claimToken,
			now: new Date(),
		});

		// A new eligible runner can reclaim it (runCount still 0).
		const second = await store.claimDueTask({
			runnerId: "other",
			now: new Date(),
			leaseMs: 60000,
		});
		assert.equal(second.claimed, true, "abandoned task must be reclaimable");
		assert.equal(second.task.runCount, 0);

		const completed = await store.completeClaimedTask({
			taskId: "abandon_me",
			runnerId: "other",
			claimToken: second.claimToken,
			result: { ok: true },
			now: new Date(),
		});
		assert.equal(completed.status, "fired");
		assert.equal(
			completed.runCount,
			1,
			"only the real completion counts as a run",
		);
	});
});

test("abandonClaimedTask recomputes nextRun for an interval task from now", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		writeFileSync(
			file,
			serializeState([
				dueTask({ type: "interval", schedule: "5m", intervalMs: 300000 }),
			]),
			{ mode: 0o600 },
		);
		const store = createTaskStore({ filePath: file });

		const claim = await store.claimDueTask({
			runnerId: "owner",
			now: new Date(),
			leaseMs: 60000,
		});
		const before = Date.now();
		const abandoned = await store.abandonClaimedTask({
			taskId: "abandon_me",
			runnerId: "owner",
			claimToken: claim.claimToken,
			now: new Date(before),
		});
		assert.equal(abandoned.status, "pending");
		// nextRun should be ~now + intervalMs, not the stale past dueAt.
		const nextMs = Date.parse(abandoned.nextRun);
		assert.ok(
			nextMs >= before + 290000,
			`interval nextRun should be ~now+5m, got ${abandoned.nextRun}`,
		);
	});
});

test("abandonClaimedTask does not resurrect a task cancelled during the claim", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		writeFileSync(
			file,
			serializeState([dueTask({ type: "interval", intervalMs: 300000 })]),
			{ mode: 0o600 },
		);
		const store = createTaskStore({ filePath: file });
		const claim = await store.claimDueTask({
			runnerId: "owner",
			now: new Date(),
			leaseMs: 60000,
		});
		await store.transaction((tasks) => {
			const task = tasks.find((item) => item.id === "abandon_me");
			task.status = "cancelled";
			task.enabled = false;
			task.nextRun = undefined;
		});

		const abandoned = await store.abandonClaimedTask({
			taskId: "abandon_me",
			runnerId: "owner",
			claimToken: claim.claimToken,
			now: new Date(),
		});
		assert.equal(abandoned.status, "cancelled");
		assert.equal(abandoned.enabled, false);
		assert.equal(abandoned.nextRun, undefined);
		assert.equal(abandoned.claimToken, undefined);
	});
});

test("abandonClaimedTask does not re-enable a task disabled during the claim", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		writeFileSync(
			file,
			serializeState([dueTask({ type: "interval", intervalMs: 300000 })]),
			{ mode: 0o600 },
		);
		const store = createTaskStore({ filePath: file });
		const claim = await store.claimDueTask({
			runnerId: "owner",
			now: new Date(),
			leaseMs: 60000,
		});
		await store.transaction((tasks) => {
			const task = tasks.find((item) => item.id === "abandon_me");
			task.status = "pending";
			task.enabled = false;
			task.nextRun = undefined;
		});

		const abandoned = await store.abandonClaimedTask({
			taskId: "abandon_me",
			runnerId: "owner",
			claimToken: claim.claimToken,
			now: new Date(),
		});
		assert.equal(abandoned.status, "pending");
		assert.equal(abandoned.enabled, false);
		assert.equal(abandoned.nextRun, undefined);
		assert.equal(abandoned.claimToken, undefined);
	});
});

test("abandonClaimedTask requires matching runner identity", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		writeFileSync(file, serializeState([dueTask()]), { mode: 0o600 });
		const store = createTaskStore({ filePath: file });

		const claim = await store.claimDueTask({
			runnerId: "owner",
			now: new Date(),
			leaseMs: 60000,
		});
		await assert.rejects(
			store.abandonClaimedTask({
				taskId: "abandon_me",
				runnerId: "intruder",
				claimToken: claim.claimToken,
				now: new Date(),
			}),
			/runner|identity|mismatch/i,
		);
	});
});

test("abandonClaimedTask requires matching claim token", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		writeFileSync(file, serializeState([dueTask()]), { mode: 0o600 });
		const store = createTaskStore({ filePath: file });

		await store.claimDueTask({
			runnerId: "owner",
			now: new Date(),
			leaseMs: 60000,
		});
		await assert.rejects(
			store.abandonClaimedTask({
				taskId: "abandon_me",
				runnerId: "owner",
				claimToken: "wrong-token",
				now: new Date(),
			}),
			/token/i,
		);
	});
});

test("abandonClaimedTask throws on missing required arguments", async () => {
	await withTempDir(async (dir) => {
		const store = createTaskStore({ filePath: join(dir, "tasks.json") });
		await assert.rejects(
			store.abandonClaimedTask({ runnerId: "o", claimToken: "t" }),
			/taskId/i,
		);
		await assert.rejects(
			store.abandonClaimedTask({ taskId: "x", claimToken: "t" }),
			/runnerId/i,
		);
		await assert.rejects(
			store.abandonClaimedTask({ taskId: "x", runnerId: "o" }),
			/claimToken/i,
		);
	});
});
