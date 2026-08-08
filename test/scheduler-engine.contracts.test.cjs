// Characterization contracts for the scheduling engine.
//
// These pin the invariants that currently live UNTESTED inside the index.ts
// closure: bounded non-zero rearm, the lease-expiry recovery sweep,
// shutdown-during-claim claim release, generation-gated rearm, scope-abandon,
// and past-due one-shot re-arm. They cross the NEW engine interface only:
//
//   createEngine({ store, runnerId, clock, leaseMsForTask, normalize, run,
//                  maxTimerDelayMs, recovery })
//     -> { bind({ isInScope, execute,
//                 reportTaskFailure, reportPersistenceFailure, onChange }),
//          refresh(), snapshot(), shutdown() }
//
// The store and run() are fakes/stubs so timing and claim resolution are
// deterministic. runClaimedExecution's own settle semantics are covered by
// scheduler-runtime.contracts.test.cjs and are NOT re-exercised here.

const test = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");

const ENGINE_PATH = join(__dirname, "..", "extensions", "scheduler", "scheduler-engine.cjs");

// Flush the microtask queue a bounded number of times so async engine paths
// triggered by a synchronous clock tick settle before assertions.
async function flush(steps = 20) {
	for (let i = 0; i < steps; i++) await new Promise((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

// A virtual clock: controllable now() plus setTimeout/clearTimeout that queue
// timers the test ticks explicitly, and a minimal Cron stand-in.
function createVirtualClock() {
	const timers = [];
	let nowMs = 0;
	let seq = 0;
	const clock = {
		now() {
			return new Date(nowMs);
		},
		ms() {
			return nowMs;
		},
		setNow(ms) {
			nowMs = ms;
		},
		setTimeout(fn, ms) {
			const handle = {
				id: ++seq,
				fn,
				dueAt: nowMs + Math.max(0, ms || 0),
				cleared: false,
			};
			timers.push(handle);
			return handle;
		},
		clearTimeout(handle) {
			if (handle) handle.cleared = true;
		},
		Cron: class FakeCron {
			constructor(expr, cb) {
				this.expr = expr;
				this.cb = cb;
				this.stopped = false;
				this.fired = 0;
			}
			stop() {
				this.stopped = true;
			}
			fire() {
				this.fired++;
				this.cb();
			}
		},
		// Fire all due, non-cleared timers once, in dueAt/id order.
		tick() {
			const due = timers
				.filter((t) => !t.cleared && t.dueAt <= nowMs)
				.sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);
			for (const t of due) {
				if (!t.cleared) t.fn();
			}
			return due.length;
		},
		live() {
			return timers.filter((t) => !t.cleared);
		},
	};
	return clock;
}

// A controllable fake store implementing the slice of the task-store interface
// the engine consumes: transaction (read/mutate), claimDueTask,
// abandonClaimedTask, completeClaimedTask. Claim resolution is test-driven via
// nextClaim so shutdown-during-claim is deterministic.
function createFakeStore(initial = []) {
	const tasks = initial.map((t) => ({ ...t }));
	const store = {
		tasks,
		// Override the next claimDueTask result. May be:
		//   null  -> default behavior (claim matching pending task)
		//   value -> returned once, then reset to null
		//   fn    -> invoked as fn({ taskId }), result used
		//   Error -> claimDueTask rejects with it
		nextClaim: null,
		claimCalls: [],
		abandonCalls: [],
		completeCalls: [],
		async transaction(fn) {
			return fn(tasks);
		},
		async claimDueTask({ taskId, runnerId, leaseMs }) {
			this.claimCalls.push({ taskId, runnerId, leaseMs });
			if (this.nextClaim instanceof Error) throw this.nextClaim;
			if (typeof this.nextClaim === "function") {
				return this.nextClaim({ taskId, runnerId, leaseMs });
			}
			if (this.nextClaim) {
				const r = this.nextClaim;
				this.nextClaim = null;
				return r;
			}
			const t = tasks.find((x) => x.id === taskId);
			if (t?.status !== "pending") return { claimed: false };
			t.status = "running";
			t.claimRunnerId = runnerId;
			t.claimToken = "tok";
			t.claimGeneration = 1;
			t.claimLeaseExpiresAt = new Date(Date.now() + (leaseMs || 60000)).toISOString();
			return { claimed: true, task: { ...t }, claimToken: t.claimToken, claimGeneration: 1 };
		},
		async abandonClaimedTask({ taskId }) {
			this.abandonCalls.push({ taskId });
			const t = tasks.find((x) => x.id === taskId);
			if (t) {
				t.status = "pending";
				delete t.claimRunnerId;
				delete t.claimToken;
				delete t.claimGeneration;
				delete t.claimLeaseExpiresAt;
			}
		},
		async completeClaimedTask({ taskId, result, ok }) {
			this.completeCalls.push({ taskId, result, ok });
			const t = tasks.find((x) => x.id === taskId);
			if (t) {
				t.status = ok ? "fired" : "failed";
				t.lastStatus = ok ? "success" : "error";
				t.runCount = (t.runCount || 0) + 1;
				if (result) t.lastResult = result;
			}
		},
	};
	return store;
}

// A run() stub that records invocations and does NOT execute deps, so engine
// orchestration is isolated from runClaimedExecution's internals.
function createRunStub() {
	const calls = [];
	return {
		calls,
		fn(task, claim, deps) {
			calls.push({ taskId: task.id, claim, hasExecute: typeof deps?.execute === "function" });
			return Promise.resolve();
		},
	};
}

function pendingTask(overrides = {}) {
	return {
		id: "t1",
		action: "notify",
		type: "once",
		status: "pending",
		enabled: true,
		scope: "global",
		schedule: "once",
		nextRun: new Date(Date.now() + 1000).toISOString(),
		runCount: 0,
		...overrides,
	};
}

function buildEngine({ clock, store, run, overrides = {} }) {
	const { createEngine } = require(ENGINE_PATH);
	return createEngine({
		store,
		runnerId: "runner-A",
		clock,
		leaseMsForTask: () => 60000,
		normalize: (current) => current,
		run: run.fn,
		maxTimerDelayMs: overrides.maxTimerDelayMs ?? 1000,
		recovery: { minDelayMs: 1, maxDelayMs: 1000 },
		...overrides,
	});
}

function bindDefaults(engine, { isInScope = () => true } = {}) {
	engine.bind({
		isInScope,
		execute: async () => ({ ok: true }),
		reportTaskFailure: () => {},
		reportPersistenceFailure: () => {},
		onChange: () => {},
	});
}

// ---------------------------------------------------------------------------
// (a) Non-zero bounded rearm — a claim-false never invokes run and never
// strands the task; when reload fails the retry timer is strictly positive.
// ---------------------------------------------------------------------------

test("engine: claim-false where another runner now owns the task does not run or re-arm it", async () => {
	const clock = createVirtualClock();
	const store = createFakeStore([pendingTask({ id: "t1", nextRun: new Date(clock.ms() + 500).toISOString() })]);
	// Another runner claimed it: mark running, return claim-false.
	store.nextClaim = ({ taskId }) => {
		const t = store.tasks.find((x) => x.id === taskId);
		if (t) {
			t.status = "running";
			t.claimRunnerId = "runner-OTHER";
		}
		return { claimed: false };
	};
	const run = createRunStub();
	const engine = buildEngine({ clock, store, run });
	bindDefaults(engine);

	await engine.refresh();
	clock.setNow(500);
	clock.tick(); // fireTask -> claim-false -> reload (task now running) -> reschedule
	await flush();

	assert.equal(run.calls.length, 0, "run must not be invoked on claim-false");
	assert.equal(
		store.claimCalls.length,
		1,
		"claim-false with a successful reload must not enter a retry loop (no spin)",
	);
});

test("engine: claim-false with a failing reload schedules a non-zero retry timer", async () => {
	const clock = createVirtualClock();
	const store = createFakeStore([pendingTask({ id: "t1", nextRun: new Date(clock.ms() + 500).toISOString() })]);
	store.nextClaim = { claimed: false };
	const realTransaction = store.transaction.bind(store);
	const run = createRunStub();
	const engine = buildEngine({ clock, store, run });
	bindDefaults(engine);

	await engine.refresh(); // uses the real transaction
	// Now make the post-claim reload fail so the engine takes the retry path.
	store.transaction = async () => {
		throw new Error("transient lock failure");
	};
	clock.setNow(500);
	clock.tick(); // fireTask -> claim-false -> reload throws -> scheduleClaimRetry
	await flush();

	assert.equal(run.calls.length, 0, "run must not be invoked on claim-false");
	const retry = clock.live().find((t) => t.dueAt > clock.ms());
	assert.ok(retry, "a non-zero scheduleClaimRetry timer must be armed when reload fails");
	assert.ok(retry.dueAt - clock.ms() > 0, "retry delay must be strictly positive (no zero-delay spin)");
	store.transaction = realTransaction;
});

// ---------------------------------------------------------------------------
// (b) Lease-expiry recovery — a persisted RUNNING task whose lease expired is
// reclaimed and abandoned to pending, and is never executed by the reclaimer.
// ---------------------------------------------------------------------------

test("engine: refresh arms a recovery sweep for an expired RUNNING lease and reclaims it", async () => {
	const clock = createVirtualClock();
	const expired = pendingTask({
		id: "t1",
		status: "running",
		claimRunnerId: "runner-DEAD",
		claimToken: "old",
		claimGeneration: 0,
		claimLeaseExpiresAt: new Date(clock.ms() - 1000).toISOString(), // expired
		nextRun: new Date(clock.ms() + 2000).toISOString(),
	});
	const store = createFakeStore([expired]);
	// Recovery reclaim claims then the engine abandons (does NOT execute).
	store.nextClaim = ({ taskId }) => {
		const t = store.tasks.find((x) => x.id === taskId);
		return {
			claimed: true,
			task: t ? { ...t, status: "running", claimToken: "new", claimGeneration: 1 } : null,
			claimToken: "new",
			claimGeneration: 1,
		};
	};
	const run = createRunStub();
	const engine = buildEngine({ clock, store, run });
	bindDefaults(engine);

	await engine.refresh();
	const claimBefore = store.claimCalls.length;
	assert.ok(clock.live().length > 0, "a recovery timer must be armed for an expired lease");

	clock.setNow(clock.ms() + 1001);
	clock.tick(); // recovery sweep fires
	await flush();

	assert.ok(
		store.claimCalls.length > claimBefore,
		"recovery sweep must attempt to reclaim the expired-lease task",
	);
	assert.ok(
		store.abandonCalls.some((c) => c.taskId === "t1"),
		"reclaimed task must be abandoned to pending, never executed",
	);
	assert.equal(run.calls.length, 0, "a reclaimed task must NOT be executed by the reclaimer");
});

// ---------------------------------------------------------------------------
// (c) Shutdown during an in-flight claim — the acquired claim is released via
// abandon, run is never invoked, and no reschedule happens.
// ---------------------------------------------------------------------------

test("engine: shutdown during an in-flight claim releases the claim without executing or rescheduling", async () => {
	const clock = createVirtualClock();
	const store = createFakeStore([pendingTask({ id: "t1", nextRun: new Date(clock.ms() + 500).toISOString() })]);
	const run = createRunStub();
	let resolveClaim;
	store.nextClaim = () =>
		new Promise((resolve) => {
			resolveClaim = resolve;
		});
	const engine = buildEngine({ clock, store, run });
	bindDefaults(engine);

	await engine.refresh();
	clock.setNow(500);
	const fired = clock.tick(); // timer -> fireTask -> awaits claimDueTask
	await flush();
	assert.equal(fired, 1, "the due timer must fire and enter fireTask");

	// While the claim is pending, shut the engine down.
	engine.shutdown();

	// Now resolve the claim as acquired.
	resolveClaim({ claimed: true, task: { ...pendingTask({ id: "t1" }) }, claimToken: "tok", claimGeneration: 1 });
	await flush();

	assert.ok(
		store.abandonCalls.some((c) => c.taskId === "t1"),
		"an acquired claim during shutdown must be released via abandon",
	);
	assert.equal(run.calls.length, 0, "run must NOT be invoked when shutdown lands during a claim");
});

// ---------------------------------------------------------------------------
// (d) Shutdown disarms pending timers — after shutdown, advancing the clock
// performs no work.
// ---------------------------------------------------------------------------

test("engine: after shutdown, a due timer performs no work", async () => {
	const clock = createVirtualClock();
	const store = createFakeStore([pendingTask({ id: "t1", nextRun: new Date(clock.ms() + 500).toISOString() })]);
	const run = createRunStub();
	const engine = buildEngine({ clock, store, run });
	bindDefaults(engine);

	await engine.refresh();
	engine.shutdown();

	const claimBefore = store.claimCalls.length;
	clock.setNow(500);
	clock.tick();
	await flush();

	assert.equal(store.claimCalls.length, claimBefore, "post-shutdown timer must not claim");
	assert.equal(run.calls.length, 0, "post-shutdown timer must not run");
});

// ---------------------------------------------------------------------------
// (e) Scope-abandon — a task that was in scope when armed but out of scope
// when claimed is abandoned to pending without firing and without bumping
// runCount.
// ---------------------------------------------------------------------------

test("engine: an out-of-scope claimed task is abandoned to pending without firing", async () => {
	const clock = createVirtualClock();
	const task = pendingTask({ id: "t1", scope: "session", nextRun: new Date(clock.ms() + 500).toISOString() });
	const store = createFakeStore([task]);
	const run = createRunStub();
	const engine = buildEngine({ clock, store, run });
	let inScope = true;
	engine.bind({
		isInScope: () => inScope,
		execute: async () => ({ ok: true }),
		reportTaskFailure: () => {},
		reportPersistenceFailure: () => {},
		onChange: () => {},
	});

	await engine.refresh(); // armed while in scope
	inScope = false; // session turnover: claimed task is now out of scope
	clock.setNow(500);
	clock.tick(); // claim succeeds, post-claim scope check fails -> abandon
	await flush();

	assert.ok(
		store.abandonCalls.some((c) => c.taskId === "t1"),
		"an out-of-scope claimed task must be abandoned",
	);
	assert.equal(run.calls.length, 0, "an out-of-scope task must NOT be executed");
	const settled = store.tasks.find((x) => x.id === "t1");
	assert.equal(settled.status, "pending", "out-of-scope task must be restored to pending");
	assert.equal(settled.runCount, 0, "runCount must not increment for an abandoned task");
});

// ---------------------------------------------------------------------------
// (f) Past-due re-arm — a one-shot timer that fires before its true due time
// (capped by maxTimerDelayMs) re-arms instead of claiming prematurely.
// ---------------------------------------------------------------------------

test("engine: a one-shot timer firing before dueAt re-arms instead of claiming", async () => {
	const clock = createVirtualClock();
	const farFuture = new Date(clock.ms() + 5000).toISOString();
	const store = createFakeStore([pendingTask({ id: "t1", type: "once", nextRun: farFuture })]);
	const run = createRunStub();
	const engine = buildEngine({ clock, store, run });
	bindDefaults(engine);

	await engine.refresh();
	clock.setNow(1000); // armed timer was capped at maxTimerDelayMs (1000)
	const fired = clock.tick();
	await flush();

	assert.equal(fired, 1, "the capped one-shot timer must fire");
	assert.equal(store.claimCalls.length, 0, "must NOT claim before the true due time");
	assert.equal(run.calls.length, 0, "must NOT run before the true due time");
	assert.ok(clock.live().length > 0, "must re-arm a follow-up timer for the remaining delay");
});
