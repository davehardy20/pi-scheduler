// Test-first safety contracts for the scheduler persistence store.
//
// These tests define the REQUIRED surface and behavior of a locked,
// cross-process task store that is NOT yet implemented. They are expected to
// FAIL for the intended reason (module not found / API missing) until step 2 of
// plan pl-9e04 lands the implementation in
// `extensions/scheduler/task-store.cjs`.
//
// They deliberately avoid spawning a full Pi process. Cross-process behavior is
// exercised with REAL concurrent child Node processes (child_process.spawn plus
// Promise.all and explicit readiness barriers) so that lock contention, stale
// lock recovery, single-claimant semantics, and atomic write visibility are
// observed at the OS level — not serialized through spawnSync loops.
//
// Concurrency invariants enforced by this harness (so the suite never flakes
// due to the test harness itself):
//   * withTempDir is async-safe: it awaits the test body and always removes
//     the directory, even when the body rejects.
//   * Every child worker rejects (and thus fails its parent test) on a non-zero
//     exit, so an implementation bug surfaces as a real assertion failure
//     rather than silently swallowed output.
//   * Contenders are spawned and parked behind a readiness barrier BEFORE the
//     lock holder releases, so workers genuinely overlap. No test relies on a
//     holder exiting before a contender starts.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const {
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
	readFileSync,
	statSync,
	existsSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

// The not-yet-implemented module. It does not exist yet, so a plain
// `require.resolve` at file scope would crash the whole test file before any
// test reported a result. We resolve lazily inside loadStore() so each test
// reports its own intended failure (MODULE_NOT_FOUND / API missing) until the
// implementation lands in step 2 of plan pl-9e04.
const STORE_PATH = join(
	__dirname,
	"..",
	"extensions",
	"scheduler",
	"task-store.cjs",
);

function loadStore() {
	return require(STORE_PATH);
}

// Async-safe temp directory helper. Awaits the (possibly async) body and
// always removes the directory in `finally`, so a rejecting test never leaks a
// temp dir or skips cleanup. Returns the body's resolved value.
async function withTempDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), "pi-scheduler-store-"));
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function stateFile(dir) {
	return join(dir, "tasks.json");
}

function serializeState(tasks) {
	return `${JSON.stringify({ version: 2, updatedAt: "now", tasks })}\n`;
}

async function waitForPath(path, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	if (!existsSync(path)) throw new Error(`timed out waiting for ${path}`);
}

function freshTask(overrides = {}) {
	return {
		id: "task_001",
		action: "notify",
		type: "once",
		status: "pending",
		enabled: true,
		scope: "cwd",
		cwd: "/tmp/project",
		schedule: "5m",
		whenText: "5m",
		createdAt: new Date("2026-07-05T12:00:00Z").toISOString(),
		dueAt: new Date("2026-07-05T12:05:00Z").toISOString(),
		nextRun: new Date("2026-07-05T12:05:00Z").toISOString(),
		runCount: 0,
		message: "hello",
		...overrides,
	};
}

// Spawn a real, concurrent child Node worker. Resolves with parsed JSON stdout.
// Rejects on non-zero exit OR unparseable output, so a worker crash is always a
// visible failure rather than silent success. This is the foundation that lets
// the suite fail only for the intended reason: until task-store.cjs exists each
// worker exits non-zero with MODULE_NOT_FOUND, which surfaces as a clean test
// failure; once it exists, any genuine concurrency bug also surfaces here.
function spawnWorker(env, script) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["-e", script], {
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				return reject(
					new Error(`worker exited with code ${code}: ${stderr || stdout}`),
				);
			}
			const trimmed = stdout.trim();
			if (!trimmed) return resolve({});
			try {
				resolve(JSON.parse(trimmed));
			} catch {
				reject(new Error(`worker emitted non-JSON stdout: ${stdout}`));
			}
		});
	});
}

// Run the same worker script N times behind a filesystem readiness barrier.
// Every process reaches the barrier before any process begins store work, which
// makes the cross-process race deterministic rather than scheduler-dependent.
async function spawnWorkers(env, script, count) {
	const barrierDir = `${env.PI_SCHEDULER_STATE_FILE}.barrier-${process.pid}-${Date.now()}`;
	mkdirSync(barrierDir, { recursive: true });
	const barrierScript = [
		`const { writeFileSync, readdirSync } = require("node:fs");`,
		`const { join } = require("node:path");`,
		`const barrierDir = ${JSON.stringify(barrierDir)};`,
		`writeFileSync(join(barrierDir, String(process.pid)), "ready");`,
		`const barrierDeadline = Date.now() + 5000;`,
		`while (readdirSync(barrierDir).length < ${count} && Date.now() < barrierDeadline) {`,
		`  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);`,
		`}`,
		`if (readdirSync(barrierDir).length < ${count}) { throw new Error("worker readiness barrier timed out"); }`,
		script,
	].join("\n");

	try {
		return await Promise.all(
			Array.from({ length: count }, () => spawnWorker(env, barrierScript)),
		);
	} finally {
		rmSync(barrierDir, { recursive: true, force: true });
	}
}

test("TaskStore module is importable", () => {
	// Contract: a dedicated testable store module must exist.
	assert.equal(typeof loadStore, "function");
	const store = loadStore();
	assert.equal(typeof store.createTaskStore, "function");
});

test("transaction serializes read-modify-write without lost updates across processes", async () => {
	// Contract: two REAL concurrent child processes each increment a per-task
	// counter by performing a full read-modify-write inside a store transaction.
	// Workers are spawned together and awaited with Promise.all, so they overlap
	// in time. With a correct cross-process lock the final value must equal the
	// sum of both increments; without serialization the second write loses the
	// first update.
	await withTempDir(async (dir) => {
		const file = stateFile(dir);
		writeFileSync(
			file,
			serializeState([freshTask({ id: "ctr", counter: 0 })]),
			{ mode: 0o600 },
		);

		const workerScript = [
			`const { createTaskStore } = require(${JSON.stringify(STORE_PATH)});`,
			`const store = createTaskStore({ filePath: process.env.PI_SCHEDULER_STATE_FILE });`,
			`// Artificial delay inside the transaction forces overlap so a missing`,
			`// lock loses updates even if processes happen to start a few ms apart.`,
			`store.transaction(async (tasks) => {`,
			`  const t = tasks.find((x) => x.id === "ctr");`,
			`  const before = t.counter;`,
			`  await new Promise((r) => setTimeout(r, 50));`,
			`  t.counter = before + 1;`,
			`  return t.counter;`,
			`}).then(`,
			`  (value) => process.stdout.write(JSON.stringify({ value })),`,
			`  (err) => { console.error(String((err && err.message) || err)); process.exit(1); },`,
			`);`,
		].join("\n");

		// Genuine concurrency: all workers overlap via Promise.all.
		await spawnWorkers({ PI_SCHEDULER_STATE_FILE: file }, workerScript, 5);

		const data = JSON.parse(readFileSync(file, "utf8"));
		const task = data.tasks.find((t) => t.id === "ctr");
		// Contract: every increment is durable. A non-locked store would drop some.
		assert.equal(
			task.counter,
			5,
			"read-modify-write must not lose updates across processes",
		);
	});
});

test("transaction reloads state inside the lock so each writer sees prior commits", async () => {
	await withTempDir(async (dir) => {
		const file = stateFile(dir);
		writeFileSync(file, serializeState([]), { mode: 0o600 });

		const workerScript = [
			`const { createTaskStore } = require(${JSON.stringify(STORE_PATH)});`,
			`const store = createTaskStore({ filePath: process.env.PI_SCHEDULER_STATE_FILE });`,
			`store.transaction(async (tasks) => {`,
			`  tasks.push({ id: "p_" + process.pid, action: "notify", type: "once", status: "pending" });`,
			`}).then(`,
			`  () => process.stdout.write(JSON.stringify({ ok: true })),`,
			`  (err) => { console.error(String((err && err.message) || err)); process.exit(1); },`,
			`);`,
		].join("\n");

		await spawnWorkers({ PI_SCHEDULER_STATE_FILE: file }, workerScript, 4);

		const data = JSON.parse(readFileSync(file, "utf8"));
		assert.equal(
			data.tasks.length,
			4,
			"every process' append must survive concurrent transactions",
		);
	});
});

test("claimDueTask yields exactly one claimant across concurrent processes", async () => {
	await withTempDir(async (dir) => {
		const file = stateFile(dir);
		const due = new Date(Date.now() - 1000).toISOString();
		writeFileSync(
			file,
			serializeState([freshTask({ id: "due_1", nextRun: due, dueAt: due })]),
			{ mode: 0o600 },
		);

		const workerScript = [
			`const { createTaskStore } = require(${JSON.stringify(STORE_PATH)});`,
			`const store = createTaskStore({ filePath: process.env.PI_SCHEDULER_STATE_FILE });`,
			`const runnerId = "runner_" + process.pid;`,
			`store.claimDueTask({ runnerId, now: new Date(), leaseMs: 60000 }).then(`,
			`  (claim) => process.stdout.write(JSON.stringify(claim)),`,
			`  (err) => { console.error(String((err && err.message) || err)); process.exit(1); },`,
			`);`,
		].join("\n");

		// Genuine concurrency: all claimants race via Promise.all.
		const claims = await spawnWorkers(
			{ PI_SCHEDULER_STATE_FILE: file },
			workerScript,
			6,
		);

		const winners = claims.filter(
			(c) => c && c.claimed === true && c.task && c.task.id === "due_1",
		);
		assert.equal(
			winners.length,
			1,
			"exactly one process must win the claim for a due task",
		);
		assert.ok(
			winners[0].runnerId,
			"the winning claim must record runner identity",
		);
		assert.ok(
			winners[0].claimToken,
			"the winning claim must issue a verifiable claim token",
		);
	});
});

test("completeClaimedTask requires matching runner identity", async () => {
	await withTempDir(async (dir) => {
		const file = stateFile(dir);
		const due = new Date(Date.now() - 1000).toISOString();
		writeFileSync(
			file,
			serializeState([freshTask({ id: "due_2", nextRun: due, dueAt: due })]),
			{ mode: 0o600 },
		);
		const store = loadStore().createTaskStore({ filePath: file });

		const claim = await store.claimDueTask({
			runnerId: "owner",
			now: new Date(),
			leaseMs: 60000,
		});
		assert.equal(claim.claimed, true);

		await assert.rejects(
			store.completeClaimedTask({
				taskId: "due_2",
				runnerId: "intruder",
				claimToken: claim.claimToken,
			}),
			/runner|identity|owner|mismatch/i,
		);

		const completed = await store.completeClaimedTask({
			taskId: "due_2",
			runnerId: "owner",
			claimToken: claim.claimToken,
			result: { ok: true },
			now: new Date(),
		});
		assert.equal(completed.status, "fired");
		assert.equal(completed.runCount, 1);
	});
});

test("expired lease recovers a stale claim but a live lease is never stolen", async () => {
	await withTempDir(async (dir) => {
		const file = stateFile(dir);
		const due = new Date(Date.now() - 1000).toISOString();
		writeFileSync(
			file,
			serializeState([freshTask({ id: "stale", nextRun: due, dueAt: due })]),
			{ mode: 0o600 },
		);
		const store = loadStore().createTaskStore({ filePath: file });

		const live = await store.claimDueTask({
			runnerId: "live_owner",
			now: new Date(),
			leaseMs: 60000,
		});
		assert.equal(live.claimed, true);

		const secondLive = await store.claimDueTask({
			runnerId: "other",
			now: new Date(),
			leaseMs: 60000,
		});
		assert.equal(
			secondLive.claimed,
			false,
			"a live claim must not be stolen by another runner",
		);

		const later = new Date(Date.now() + 120_000);
		const recovered = await store.claimDueTask({
			runnerId: "recoverer",
			now: later,
			leaseMs: 60000,
		});
		assert.equal(
			recovered.claimed,
			true,
			"an expired lease must be recoverable by a new runner",
		);
		assert.equal(recovered.runnerId, "recoverer");
	});
});

test("live-lock: lock acquisition times out under GENUINE concurrent contention", async () => {
	// Contract, separated from stale-lock recovery: while another process
	// ACTIVELY holds the lock (genuine overlap, not a pre-exited holder), a
	// contender must give up within lockTimeoutMs rather than hang. We enforce
	// real overlap with a readiness barrier: the contender is spawned and parks
	// until the holder confirms it has entered its transaction, so the two are
	// provably contending at the same instant.
	await withTempDir(async (dir) => {
		const file = stateFile(dir);
		writeFileSync(file, serializeState([]), { mode: 0o600 });
		// Barrier files: holder writes `held` once inside the transaction; the
		// contender only starts its acquire after seeing it, guaranteeing overlap.
		const heldSignal = join(dir, "held.signal");
		const contenderDone = join(dir, "contender-done.signal");

		const holderScript = [
			`const { writeFileSync } = require("node:fs");`,
			`const { createTaskStore } = require(${JSON.stringify(STORE_PATH)});`,
			`const store = createTaskStore({ filePath: process.env.PI_SCHEDULER_STATE_FILE, lockTimeoutMs: 50, staleLockMs: 5000 });`,
			`// Hold the lock long enough that the contender must time out first.`,
			`store.transaction(async () => {`,
			`  writeFileSync(${JSON.stringify(heldSignal)}, "held");`,
			`  await new Promise((r) => setTimeout(r, 800));`,
			`}).then(`,
			`  () => process.stdout.write(JSON.stringify({ held: true })),`,
			`  (err) => { console.error(String((err && err.message) || err)); process.exit(1); },`,
			`);`,
		].join("\n");

		const contenderScript = [
			`const { writeFileSync, existsSync } = require("node:fs");`,
			`const { createTaskStore } = require(${JSON.stringify(STORE_PATH)});`,
			`// Wait until the holder is provably inside its transaction.`,
			`const deadline = Date.now() + 5000;`,
			`while (!existsSync(${JSON.stringify(heldSignal)}) && Date.now() < deadline) {`,
			`  await new Promise((r) => setTimeout(r, 5));`,
			`}`,
			`if (!existsSync(${JSON.stringify(heldSignal)})) { console.error("holder never signaled"); process.exit(1); }`,
			`const store = createTaskStore({ filePath: process.env.PI_SCHEDULER_STATE_FILE, lockTimeoutMs: 50, staleLockMs: 5000 });`,
			`const start = Date.now();`,
			`store.transaction(async () => "ok").then(`,
			`  () => { writeFileSync(${JSON.stringify(contenderDone)}, String(Date.now() - start)); process.stdout.write(JSON.stringify({ acquired: true })); },`,
			`  (err) => {`,
			`    // A bounded-timeout implementation rejects; record elapsed so the`,
			`    // assertion below can confirm it was bounded and during contention.`,
			`    writeFileSync(${JSON.stringify(contenderDone)}, String(Date.now() - start));`,
			`    process.stdout.write(JSON.stringify({ acquired: false, error: String((err && err.message) || err) }));`,
			`  },`,
			`);`,
		].join("\n");

		// Note: the contender script uses top-level await, valid in Node -e via an
		// async IIFE wrapper so it stays portable across CJS evaluation.
		const contenderWrapped = `(async () => { ${contenderScript} })();`;

		// Spawn BOTH first (overlap), then await. The holder signals inside its txn;
		// the contender parks on the signal, so they genuinely contend.
		const holderP = spawnWorker(
			{ PI_SCHEDULER_STATE_FILE: file },
			holderScript,
		);
		const contenderP = spawnWorker(
			{ PI_SCHEDULER_STATE_FILE: file },
			contenderWrapped,
		);

		const [holderOut, contenderOut] = await Promise.all([holderP, contenderP]);
		assert.equal(holderOut.held, true, "holder must complete its transaction");
		assert.equal(
			contenderOut.acquired,
			false,
			"a contender must time out while a live owner still holds the lock",
		);
		assert.match(contenderOut.error || "", /lock|timeout|timed out/i);

		const elapsedRaw = readFileSync(contenderDone, "utf8");
		const elapsed = Number(elapsedRaw);
		assert.ok(
			Number.isFinite(elapsed) && elapsed >= 0,
			`contender must record a finite elapsed time, got ${elapsedRaw}`,
		);
		assert.ok(
			elapsed < 5000,
			`contender must be bounded under live contention, took ${elapsed}ms`,
		);
		assert.doesNotThrow(
			() => JSON.parse(readFileSync(file, "utf8")),
			"state file stays valid JSON",
		);
	});
});

test("stale lock recovery reclaims a lock abandoned by a crashed process", async () => {
	await withTempDir(async (dir) => {
		const file = stateFile(dir);
		writeFileSync(file, serializeState([]), { mode: 0o600 });

		const crashScript = [
			`const { createTaskStore } = require(${JSON.stringify(STORE_PATH)});`,
			`const store = createTaskStore({ filePath: process.env.PI_SCHEDULER_STATE_FILE, lockTimeoutMs: 500, staleLockMs: 50 });`,
			`store.transaction(async () => {`,
			`  process.stdout.write(JSON.stringify({ locked: true }), () => process.exit(0));`,
			`  await new Promise(() => {});`,
			`}).catch((err) => { console.error(String((err && err.message) || err)); process.exit(1); });`,
		].join("\n");

		const crashed = await spawnWorker(
			{ PI_SCHEDULER_STATE_FILE: file },
			crashScript,
		);
		assert.equal(
			crashed.locked,
			true,
			"crashing worker must first acquire the lock",
		);
		await new Promise((resolve) => setTimeout(resolve, 100));

		const store = loadStore().createTaskStore({
			filePath: file,
			lockTimeoutMs: 500,
			staleLockMs: 50,
		});
		const start = Date.now();
		await store.transaction(() => "ok");
		assert.ok(
			Date.now() - start < 2000,
			"abandoned lock must be reclaimed within the bounded timeout",
		);
		assert.doesNotThrow(() => JSON.parse(readFileSync(file, "utf8")));
	});
});

test("store writes the state file and a store-created nested directory with restrictive permissions", async () => {
	await withTempDir(async (dir) => {
		const nestedDir = join(dir, "state", "nested");
		const file = join(nestedDir, "tasks.json");
		assert.ok(
			!existsSync(nestedDir),
			"precondition: nested state dir must not exist yet",
		);

		const store = loadStore().createTaskStore({ filePath: file });
		await store.transaction((tasks) => {
			tasks.push(freshTask());
		});

		assert.ok(existsSync(file), "store must create the state file");
		assert.ok(
			existsSync(nestedDir),
			"store must create the nested state directory",
		);
		const fileMode = statSync(file).mode & 0o777;
		assert.ok(
			fileMode <= 0o600,
			`state file must be owner-only, got 0o${fileMode.toString(8)}`,
		);
		const dirMode = statSync(nestedDir).mode & 0o777;
		assert.ok(
			dirMode <= 0o700,
			`state directory must be owner-only, got 0o${dirMode.toString(8)}`,
		);
	});
});

test("store writes are atomically visible to a concurrent reader", async () => {
	await withTempDir(async (dir) => {
		const file = stateFile(dir);
		const readyFile = join(dir, "reader.ready");
		const store = loadStore().createTaskStore({ filePath: file });
		await store.transaction((tasks) => {
			tasks.push(freshTask({ id: "seed" }));
		});

		const readerScript = [
			`const { readFileSync, existsSync, writeFileSync } = require("node:fs");`,
			`const file = process.env.PI_SCHEDULER_STATE_FILE;`,
			`writeFileSync(${JSON.stringify(join("__DIR__", "reader.ready"))}.replace("__DIR__", process.env.PI_SCHEDULER_TEMP_DIR), "ready");`,
			`let snapshots = 0;`,
			`let bad = 0;`,
			`const end = Date.now() + 1500;`,
			`while (Date.now() < end) {`,
			`  if (!existsSync(file)) continue;`,
			`  let raw;`,
			`  try { raw = readFileSync(file, "utf8"); } catch { continue; }`,
			`  if (!raw) continue;`,
			`  snapshots++;`,
			`  try { JSON.parse(raw); } catch { bad++; }`,
			`}`,
			`process.stdout.write(JSON.stringify({ snapshots, bad }));`,
		].join("\n");

		const readerP = spawnWorker(
			{ PI_SCHEDULER_STATE_FILE: file, PI_SCHEDULER_TEMP_DIR: dir },
			readerScript,
		);
		await waitForPath(readyFile);

		for (let i = 0; i < 40; i++) {
			await store.transaction((tasks) => {
				tasks.push(
					freshTask({ id: `atomic_${i}`, message: "x".repeat(16_384) }),
				);
			});
		}

		const readerOut = await readerP;
		assert.ok(
			readerOut.snapshots > 0,
			"reader must observe state while writes are in progress",
		);
		assert.equal(
			readerOut.bad,
			0,
			"every concurrent snapshot must contain valid JSON",
		);
		assert.doesNotThrow(
			() => JSON.parse(readFileSync(file, "utf8")),
			"final state file must be valid JSON",
		);
	});
});
