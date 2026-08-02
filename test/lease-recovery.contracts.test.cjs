// Integration contract for lease-expiry recovery at runtime (high fix 2).
//
// The actual index runtime must (a) detect persisted RUNNING tasks whose
// leases have expired (a crashed owner) and reclaim them, and (b) after a
// claim returns false, reload/re-arm so a crashed owner is reclaimed after
// expiry. This exercises the runtime helper against the real store so the
// composed behavior is verified, not just the module in isolation.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const ROOT = join(__dirname, "..", "extensions", "scheduler");
const { createTaskStore } = require(join(ROOT, "task-store.cjs"));
const { tasksWithExpiredLeases, nextLeaseRecoveryDelay } = require(
	join(ROOT, "scheduler-runtime.cjs"),
);

async function withTempDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), "pi-scheduler-lease-"));
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function serializeState(tasks) {
	return `${JSON.stringify({ version: 2, updatedAt: "now", tasks })}\n`;
}

function runningTask(overrides = {}) {
	return {
		id: "crashed",
		action: "notify",
		type: "once",
		status: "running",
		enabled: true,
		scope: "cwd",
		cwd: "/tmp/project",
		schedule: "5m",
		whenText: "5m",
		createdAt: new Date().toISOString(),
		dueAt: new Date(Date.now() - 60000).toISOString(),
		nextRun: new Date(Date.now() - 60000).toISOString(),
		runCount: 0,
		message: "hi",
		runnerId: "crashed_owner",
		claimToken: "old_token",
		claimLeaseExpiresAt: new Date(Date.now() - 30000).toISOString(),
		...overrides,
	};
}

test("runtime recovery: a persisted RUNNING task with an expired lease is reclaimed by a new runner", async () => {
	// Scenario: a previous process claimed a task and crashed mid-run. The
	// persisted state shows it RUNNING with an expired lease. On startup, the
	// runtime detects it via tasksWithExpiredLeases and reclaims it through the
	// store, then completes it.
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		writeFileSync(file, serializeState([runningTask()]), { mode: 0o600 });
		const store = createTaskStore({ filePath: file });

		// Read current state through a read-only transaction.
		const tasks = await store.transaction((current) => current.slice());
		const now = new Date();
		const expired = tasksWithExpiredLeases(tasks, now);
		assert.equal(
			expired.length,
			1,
			"the crashed running task must be detected",
		);

		// Reclaim it: a fresh runner claims the (now-recoverable) task.
		const claim = await store.claimDueTask({
			runnerId: "recoverer",
			now,
			leaseMs: 60000,
			taskId: expired[0].id,
		});
		assert.equal(
			claim.claimed,
			true,
			"the expired-lease task must be reclaimable",
		);
		assert.equal(claim.task.id, "crashed");

		const completed = await store.completeClaimedTask({
			taskId: "crashed",
			runnerId: "recoverer",
			claimToken: claim.claimToken,
			result: { ok: true },
			now,
		});
		assert.equal(completed.status, "fired");
	});
});

test("runtime recovery: a claim that returns false re-arms via nextLeaseRecoveryDelay, not a zero-delay loop", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		// A RUNNING task with a lease that expires soon.
		const expiresSoon = new Date(Date.now() + 500).toISOString();
		writeFileSync(
			file,
			serializeState([runningTask({ claimLeaseExpiresAt: expiresSoon })]),
			{
				mode: 0o600,
			},
		);
		const store = createTaskStore({ filePath: file });

		// First claim attempt: the task is RUNNING with a (still) live lease, so
		// claim returns false. The runtime must re-arm using
		// nextLeaseRecoveryDelay instead of spinning at zero delay.
		const claimNow = await store.claimDueTask({
			runnerId: "new_owner",
			now: new Date(),
			leaseMs: 60000,
		});
		assert.equal(
			claimNow.claimed,
			false,
			"a running task with a live lease must not be claimed yet",
		);

		// The runtime computes a bounded, non-zero rearm delay.
		const tasks = await store.transaction((current) => current.slice());
		const delay = nextLeaseRecoveryDelay(tasks, new Date());
		assert.ok(delay !== null, "a running task must schedule recovery");
		assert.ok(delay >= 1, "rearm delay must be non-zero (no spin)");

		// After the lease expires, a reclaim succeeds.
		await new Promise((r) => setTimeout(r, 600));
		const reclaimed = await store.claimDueTask({
			runnerId: "new_owner",
			now: new Date(),
			leaseMs: 60000,
		});
		assert.equal(
			reclaimed.claimed,
			true,
			"after expiry the crashed task is reclaimed",
		);
	});
});
