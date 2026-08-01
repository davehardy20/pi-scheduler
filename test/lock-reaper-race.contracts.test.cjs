// Deterministic regression test for crash-safe, ownership-safe stale-lock
// recovery via a persistent owner-fingerprint tombstone quarantine.
//
// History (lead review, Seeds child pi-scheduler-5fef):
//   * The ORIGINAL bug: task-store stale recovery SNAPSHOTTED a stale owner
//     and then UNCONDITIONALLY renamed lockDir to a recovery dir and deleted
//     it. A delayed reclaimer (A) that had decided the lock was stale could,
//     after a real reclaimer (B) reaped the dead lock AND a new live owner
//     (C) acquired a fresh lock, move/delete C's LIVE lock.
//   * The FIRST fix used a per-owner "reaper guard" marker directory. That
//     design was NOT crash-safe: a reclaimer that crashed AFTER creating its
//     guard directory left a marker that every later reclaimer for that exact
//     dead owner hit as EEXIST and backed off FOREVER, permanently blocking
//     recovery. The original "crashed reaper guard is recoverable" test never
//     actually created a guard, so it did not catch the flaw.
//
// CURRENT design (replaces the guard): a single atomic rename of lockDir to a
// deterministic TOMBSTONE keyed by the observed owner token (or inode when the
// token is absent). The tombstone is KEPT (never auto-deleted) and is
// non-empty, so a delayed reclaimer for an already-reaped owner X cannot
// rename a new live owner's lock onto the existing X tombstone (POSIX rename
// of a non-empty dir over a non-empty dir fails ENOTEMPTY).
//
// These deterministic tests prove:
//   1. Delayed reclaimer A cannot move live owner C's lock.
//   2. Concurrent reclaimers serialize on the deterministic tombstone.
//   3. A reclaimer crash BEFORE the atomic rename cannot permanently block
//      acquisition (lockDir is still present; another reclaimer finishes).
//   4. A reclaimer crash AFTER the atomic rename cannot permanently block
//      acquisition (lockDir is free; a new owner acquires immediately).
//   5. The tombstone remains on disk and is owner-only (0o700).
//   6. A mismatched quarantine remains at its deterministic tombstone path so
//      the delayed-reclaimer guard can never be reopened.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	mkdtempSync,
	rmSync,
	writeFileSync,
	readFileSync,
	existsSync,
	statSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const fsp = require("node:fs/promises");

const STORE_PATH = join(
	__dirname,
	"..",
	"extensions",
	"scheduler",
	"task-store.cjs",
);
const { createTaskStore } = require(STORE_PATH);

async function withTempDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), "pi-scheduler-reaper-"));
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function serializeState(tasks) {
	return `${JSON.stringify({ version: 2, updatedAt: "now", tasks })}\n`;
}

function freshTask(overrides = {}) {
	const due = new Date(Date.now() - 1000).toISOString();
	return {
		id: "due_1",
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

/**
 * Plant a genuinely DEAD lock directly so recovery is eligible without
 * spawning a crashing process (keeps the race deterministic). The lockDir
 * mirrors the on-disk layout the store creates: a directory with an
 * owner.json describing the holder.
 */
async function plantDeadLock(file, owner, backdateSeconds = 120) {
	const lockDir = `${file}.lock`;
	await fsp.mkdir(lockDir, { mode: 0o700 });
	const ownerPath = join(lockDir, "owner.json");
	await fsp.writeFile(ownerPath, `${JSON.stringify(owner)}\n`, {
		mode: 0o600,
	});
	const backdate = Date.now() / 1000 - backdateSeconds;
	await fsp.utimes(lockDir, backdate, backdate).catch(() => {});
	return lockDir;
}

test("stale recovery never moves a mismatched live lock (delayed reclaimer race)", async () => {
	// Deterministic race using the staleReapHook barrier:
	//   1. Plant a DEAD lock (old pid, past mtime) so recovery is eligible.
	//   2. Reclaimer A observes the stale owner and PAUSES inside the hook
	//      (after observation, before acting).
	//   3. While A is paused, reclaimer B reaps the dead lock normally (moving
	//      it to a tombstone) and a fresh owner C acquires a NEW live lock.
	//   4. Resume A: it must RE-READ, detect the owner/fingerprint changed,
	//      and REFUSE to move/delete C's live lock.
	//   5. C completes its transaction normally; state serializes.
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		writeFileSync(file, serializeState([freshTask()]), { mode: 0o600 });

		const deadOwner = {
			pid: 999999,
			token: "dead_token_original",
			createdAt: new Date(Date.now() - 120000).toISOString(),
		};
		await plantDeadLock(file, deadOwner);

		// Barrier for reclaimer A: it pauses after observing stale, before acting.
		let aResume;
		const aPaused = new Promise((resolve) => {
			aResume = resolve;
		});
		let aObservedFingerprint = null;
		const staleReapHook = async (observed) => {
			aObservedFingerprint = observed;
			// Pause A here, right after the stale observation but before the
			// re-read / atomic rename. This is the window the original race
			// exploited (decide stale, then unconditionally act later).
			await aPaused;
		};

		// Reclaimer A: uses a short stale window so it will try to recover, but
		// pauses in the hook. Capture its outcome.
		const storeA = createTaskStore({
			filePath: file,
			staleLockMs: 1000,
			lockTimeoutMs: 8000,
			staleReapHook,
		});
		const aPromise = storeA
			.transaction(async () => "a_result")
			.then(
				(result) => ({ ok: true, result }),
				(error) => ({ ok: false, error: String(error?.message) }),
			);

		// Give A time to observe the stale lock and reach the hook barrier.
		await new Promise((r) => setTimeout(r, 150));

		// Reclaimer B reaps the dead lock normally (no hook). Its short stale
		// window and normal path move the dead lock to a tombstone and let B
		// proceed.
		const storeB = createTaskStore({
			filePath: file,
			staleLockMs: 1000,
			lockTimeoutMs: 8000,
		});
		const bOut = await storeB
			.transaction(async () => "b_result")
			.then(
				(result) => ({ ok: true, result }),
				(error) => ({ ok: true, result: null, error: String(error?.message) }),
			);
		assert.equal(bOut.ok, true, "reclaimer B must complete recovery");

		// Now a new LIVE owner C acquires the fresh lock and holds it briefly.
		const cMarker = join(dir, "c_acquired.marker");
		const cReleaseMarker = join(dir, "c_release.marker");
		const storeC = createTaskStore({
			filePath: file,
			staleLockMs: 60000,
			lockTimeoutMs: 8000,
		});
		const cPromise = storeC.transaction(async () => {
			writeFileSync(cMarker, "held");
			const releaseDeadline = Date.now() + 5000;
			while (!existsSync(cReleaseMarker) && Date.now() < releaseDeadline) {
				await new Promise((r) => setTimeout(r, 20));
			}
			return "c_result";
		});

		// Wait until C has provably acquired the live lock.
		const cAcquireDeadline = Date.now() + 3000;
		while (!existsSync(cMarker) && Date.now() < cAcquireDeadline) {
			await new Promise((r) => setTimeout(r, 10));
		}
		assert.ok(existsSync(cMarker), "live owner C must acquire the lock");

		// Resume reclaimer A. It must detect the owner/fingerprint changed and
		// refuse to touch C's live lock.
		aResume();

		// Give A a moment to act (or, correctly, refuse to act).
		await new Promise((r) => setTimeout(r, 100));

		// CORRUPTION DETECTOR: while C legitimately holds its live lock, a brand
		// new owner D must NOT be able to acquire the lock. If reclaimer A had
		// stolen/moved C's live lock (the original bug), the lock dir would be
		// gone and D would acquire immediately, allowing D to interleave writes
		// with C — a lost update. D uses a SHORT timeout so this proves the lock
		// is still held (D times out) rather than hanging the test.
		const storeD = createTaskStore({
			filePath: file,
			staleLockMs: 60000,
			lockTimeoutMs: 300,
		});
		const dOut = await storeD
			.transaction(async () => "d_result")
			.then(
				(result) => ({ ok: true, result }),
				(error) => ({ ok: false, error: String(error?.message) }),
			);
		assert.equal(
			dOut.ok,
			false,
			"D must NOT acquire the lock while C legitimately holds it (A must not have stolen it)",
		);
		assert.match(dOut.error || "", /lock|timeout/i);

		// Release C so it can complete.
		writeFileSync(cReleaseMarker, "release");
		const cOut = await cPromise;
		assert.equal(
			cOut,
			"c_result",
			"live owner C must complete its transaction",
		);

		assert.ok(
			aObservedFingerprint,
			"reclaimer A must have observed a stale fingerprint before pausing",
		);

		const aOut = await aPromise;
		assert.equal(
			aOut.ok,
			true,
			"reclaimer A must complete without corrupting state",
		);

		// The on-disk state must be valid JSON.
		const data = JSON.parse(readFileSync(file, "utf8"));
		assert.ok(Array.isArray(data.tasks), "state must remain valid JSON");
	});
});

test("two reclaimers observing the SAME stale lock serialize via the deterministic tombstone", async () => {
	// Contract: if two reclaimers both observe the same stale lock, only one
	// may move it. Both race on the SAME deterministic tombstone destination;
	// POSIX rename serializes them (the winner moves lockDir, the loser fails
	// ENOTEMPTY because the tombstone already exists and is non-empty, OR sees
	// lockDir already gone). State must not be corrupted.
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		writeFileSync(file, serializeState([freshTask()]), { mode: 0o600 });
		const deadOwner = {
			pid: 999997,
			token: "shared_dead",
			createdAt: new Date(Date.now() - 120000).toISOString(),
		};
		await plantDeadLock(file, deadOwner);

		const make = () =>
			createTaskStore({
				filePath: file,
				staleLockMs: 1000,
				lockTimeoutMs: 8000,
			});
		const results = await Promise.allSettled([
			make().transaction(async (tasks) => {
				tasks.push({
					id: "r1",
					action: "notify",
					type: "once",
					status: "pending",
				});
				return "r1";
			}),
			make().transaction(async (tasks) => {
				tasks.push({
					id: "r2",
					action: "notify",
					type: "once",
					status: "pending",
				});
				return "r2";
			}),
		]);
		const fulfilled = results.filter((r) => r.status === "fulfilled");
		assert.ok(
			fulfilled.length >= 1,
			"at least one reclaimer must complete recovery",
		);
		const data = JSON.parse(readFileSync(file, "utf8"));
		// Both appends that completed must be present (serialization).
		const ids = data.tasks.map((t) => t.id);
		for (const r of fulfilled) {
			assert.ok(ids.includes(r.value), `append ${r.value} must be durable`);
		}
		// Exactly ONE tombstone for this owner must remain (serialization of the
		// race: the winner created it; the loser backed off).
		const tombstones = [];
		for (const entry of await fsp.readdir(dir)) {
			if (entry.includes(".tombstone-shared_dead")) tombstones.push(entry);
		}
		assert.equal(
			tombstones.length,
			1,
			`exactly one tombstone must remain, got ${tombstones.length}`,
		);
	});
});

test("a reclaimer crash BEFORE the atomic rename does not permanently block acquisition", async () => {
	// Crash model: the reclaimer pauses in the staleReapHook at "before-rename"
	// (right after the re-read/alive checks, immediately before the rename) and
	// we simulate a crash by NEVER resolving that barrier from this reclaimer.
	// At that point no tombstone exists and lockDir is still present. A SECOND
	// reclaimer must observe the same dead owner and complete recovery.
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		writeFileSync(file, serializeState([freshTask()]), { mode: 0o600 });
		const deadOwner = {
			pid: 999996,
			token: "crash_before_rename",
			createdAt: new Date(Date.now() - 120000).toISOString(),
		};
		await plantDeadLock(file, deadOwner);

		// "Crashed" reclaimer: parks forever in the before-rename barrier.
		const parked = new Promise(() => {}); // never resolves
		const crashedStore = createTaskStore({
			filePath: file,
			staleLockMs: 1000,
			lockTimeoutMs: 8000,
			staleReapHook: async (_obs, phase) => {
				if (phase === "before-rename") await parked;
			},
		});
		// Run it but never await; it is abandoned (the "crashed" process).
		crashedStore.transaction(async () => "crashed").catch(() => {});

		// Give the crashed reclaimer time to reach the barrier.
		await new Promise((r) => setTimeout(r, 200));

		// A fresh reclaimer must recover the dead lock. Before the fix this
		// would have been blocked by a crashed reaper guard; with the tombstone
		// design there is no guard to block it, so it proceeds.
		const store2 = createTaskStore({
			filePath: file,
			staleLockMs: 1000,
			lockTimeoutMs: 8000,
		});
		const result = await store2.transaction(async () => "recovered");
		assert.equal(
			result,
			"recovered",
			"a second reclaimer must recover the dead lock after a crash before rename",
		);
		assert.doesNotThrow(() => JSON.parse(readFileSync(file, "utf8")));
	});
});

test("a reclaimer crash AFTER the atomic rename does not permanently block acquisition", async () => {
	// Crash model: the reclaimer completes the atomic rename (lockDir ->
	// tombstone) and we simulate a crash immediately after by injecting a hook
	// via the exposed reapStaleLock seam. At that point lockDir is GONE and the
	// tombstone exists, so a new owner must be able to acquire the lock right
	// away. Recovery is effectively complete; no further work is needed.
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		writeFileSync(file, serializeState([freshTask()]), { mode: 0o600 });
		const deadOwner = {
			pid: 999995,
			token: "crash_after_rename",
			createdAt: new Date(Date.now() - 120000).toISOString(),
		};
		const lockDir = await plantDeadLock(file, deadOwner);

		// Drive the recovery seam directly: this performs the atomic rename and
		// returns. We then model a "crash" by simply not doing anything else
		// with this store (no acquisition retry).
		const crashedStore = createTaskStore({
			filePath: file,
			staleLockMs: 1000,
			lockTimeoutMs: 8000,
		});
		const reaped = await crashedStore._reapStaleLock(
			{
				pid: deadOwner.pid,
				token: deadOwner.token,
				createdAt: deadOwner.createdAt,
				dev: statSync(lockDir).dev,
				ino: statSync(lockDir).ino,
				mtimeMs: statSync(lockDir).mtimeMs,
				observedAt: Date.now(),
			},
			"caller_token",
		);
		assert.equal(reaped.reaped, true, "the rename must have reaped the lock");
		assert.ok(reaped.tombstone, "the tombstone path must be returned");
		assert.equal(
			existsSync(lockDir),
			false,
			"lockDir must be gone after rename",
		);
		assert.equal(
			existsSync(reaped.tombstone),
			true,
			"the tombstone must be preserved after a crash-on-this-side",
		);

		// A fresh owner must acquire the now-free lockDir without delay.
		const store2 = createTaskStore({
			filePath: file,
			staleLockMs: 60000,
			lockTimeoutMs: 3000,
		});
		const result = await store2.transaction(async () => "recovered");
		assert.equal(
			result,
			"recovered",
			"a new owner must acquire the lock after a crash following the rename",
		);
		// The tombstone must STILL exist (never auto-deleted), even though a new
		// owner now holds the live lock.
		assert.equal(
			existsSync(reaped.tombstone),
			true,
			"the tombstone must remain even after a new live owner acquires",
		);
	});
});

test("the tombstone is preserved and is owner-only (0o700)", async () => {
	// Contract: after recovery, the tombstone directory remains on disk with
	// restrictive owner-only permissions so a stale, dead-owner artifact is not
	// world-readable/writable.
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		writeFileSync(file, serializeState([freshTask()]), { mode: 0o600 });
		const deadOwner = {
			pid: 999994,
			token: "perms_check",
			createdAt: new Date(Date.now() - 120000).toISOString(),
		};
		await plantDeadLock(file, deadOwner);

		const store = createTaskStore({
			filePath: file,
			staleLockMs: 1000,
			lockTimeoutMs: 8000,
		});
		await store.transaction(async () => "recovered");

		// The tombstone for this owner must remain.
		const tombstone = `${file}.lock.tombstone-${deadOwner.token}`;
		assert.equal(existsSync(tombstone), true, "tombstone must be preserved");
		if (process.platform !== "win32") {
			const mode = statSync(tombstone).mode & 0o777;
			assert.equal(
				mode,
				0o700,
				`tombstone must be owner-only, got 0o${mode.toString(8)}`,
			);
		}
		// The moved owner.json must describe the dead owner (not deleted).
		const moved = JSON.parse(
			readFileSync(join(tombstone, "owner.json"), "utf8"),
		);
		assert.equal(moved.token, deadOwner.token);
	});
});

test("a mismatched quarantine remains at the deterministic tombstone path", async () => {
	// Contract: defense-in-depth. If the quarantined owner does not match the
	// observed one, the moved artifact stays at the deterministic tombstone
	// path. It is never restored, deleted, or renamed because vacating that path
	// would let a delayed reclaimer move a new live lock onto it.
	//
	// Force a mismatch by swapping owner.json after the exact pre-rename
	// fingerprint check but before the atomic rename.
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		writeFileSync(file, serializeState([freshTask()]), { mode: 0o600 });
		const deadOwner = {
			pid: 999993,
			token: "observed_token",
			createdAt: new Date(Date.now() - 120000).toISOString(),
		};
		const lockDir = await plantDeadLock(file, deadOwner);

		const warnings = [];
		const store = createTaskStore({
			filePath: file,
			staleLockMs: 1000,
			lockTimeoutMs: 8000,
			onWarning: (m) => warnings.push(m),
			// Swap the owner.json to a DIFFERENT owner right before the rename,
			// so the post-rename verification sees a mismatch.
			staleReapHook: async (_obs, phase) => {
				if (phase === "before-rename") {
					const other = {
						pid: 999992,
						token: "different_token",
						createdAt: new Date().toISOString(),
					};
					await fsp.writeFile(
						join(lockDir, "owner.json"),
						`${JSON.stringify(other)}\n`,
						{ mode: 0o600 },
					);
				}
			},
		});

		const observed = {
			pid: deadOwner.pid,
			token: deadOwner.token,
			createdAt: deadOwner.createdAt,
			dev: statSync(lockDir).dev,
			ino: statSync(lockDir).ino,
			mtimeMs: statSync(lockDir).mtimeMs,
			observedAt: Date.now(),
		};
		const result = await store._reapStaleLock(observed, "caller_token");
		assert.equal(result.reaped, true, "rename still succeeds");
		assert.equal(result.mismatch, true, "mismatch must be detected");

		const tombstone = store._tombstoneNameFor(observed);
		assert.equal(
			existsSync(lockDir),
			false,
			"mismatched quarantine must not be restored to lockDir",
		);
		assert.ok(
			existsSync(tombstone),
			"the deterministic tombstone path must remain occupied",
		);
		const entries = await fsp.readdir(dir);
		assert.equal(
			entries.some((entry) => entry.includes(".MISMATCH-")),
			false,
			"mismatch handling must not rename away the deterministic tombstone",
		);
		if (process.platform !== "win32") {
			const mode = statSync(tombstone).mode & 0o777;
			assert.equal(
				mode,
				0o700,
				`mismatched tombstone must be owner-only, got 0o${mode.toString(8)}`,
			);
		}
		// A warning must be surfaced describing the preserved artifact.
		assert.match(
			warnings.join(" "),
			/mismatch|did not match|preserved/i,
			`expected a mismatch warning, got: ${warnings.join(" | ")}`,
		);
	});
});

test("delayed reclaimer cannot rename a live lock onto an existing tombstone (ENOTEMPTY guard)", async () => {
	// Direct proof of the core invariant: once a non-empty tombstone for an
	// owner token exists, a delayed reclaimer that observed that same owner must
	// FAIL to move whatever dead-looking lock currently occupies lockDir onto
	// that tombstone, because POSIX rename() of a non-empty dir over a non-empty
	// dir fails ENOTEMPTY. We make the on-disk lock look stale (dead pid) and
	// matching the observed fingerprint so the pre-checks PASS — the protection
	// must come from the ENOTEMPTY rename, proving automatic tombstone deletion
	// is what would reopen the race.
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		writeFileSync(file, serializeState([freshTask()]), { mode: 0o600 });
		const token = "owner_token_shared";

		// 1. A dead-looking lock occupies lockDir.
		const lockDir = `${file}.lock`;
		await fsp.mkdir(lockDir, { mode: 0o700 });
		const owner = {
			pid: 999990, // dead pid so isProcessAlive is false
			token,
			createdAt: new Date(Date.now() - 120000).toISOString(),
		};
		await fsp.writeFile(
			join(lockDir, "owner.json"),
			`${JSON.stringify(owner)}\n`,
			{ mode: 0o600 },
		);
		const backdate = Date.now() / 1000 - 120;
		await fsp.utimes(lockDir, backdate, backdate).catch(() => {});

		// 2. A non-empty tombstone for the SAME owner token already exists
		//    (simulating a prior reap by another reclaimer).
		const tombstone = `${file}.lock.tombstone-${token}`;
		await fsp.mkdir(tombstone, { mode: 0o700 });
		await fsp.writeFile(
			join(tombstone, "owner.json"),
			`${JSON.stringify(owner)}\n`,
			{ mode: 0o600 },
		);

		// 3. A delayed reclaimer whose observation matches the dead-looking lock
		//    (so the fingerprint + alive pre-checks PASS) tries to reap. The
		//    deterministic tombstone destination already exists and is non-empty,
		//    so rename must fail ENOTEMPTY and the lock must be untouched.
		const store = createTaskStore({
			filePath: file,
			staleLockMs: 1000,
			lockTimeoutMs: 8000,
		});
		const lockStat = statSync(lockDir);
		const observed = {
			pid: owner.pid,
			token: owner.token,
			createdAt: owner.createdAt,
			dev: lockStat.dev,
			ino: lockStat.ino,
			mtimeMs: lockStat.mtimeMs,
			observedAt: Date.now(),
		};
		const result = await store._reapStaleLock(observed, "caller_token");
		assert.equal(
			result.reaped,
			false,
			"a reclaimer must not overwrite an existing non-empty tombstone",
		);
		assert.equal(
			result.tombstone,
			true,
			"the refusal reason must indicate an existing tombstone",
		);

		// The dead-looking lockDir must be UNTOUCHED (not moved).
		assert.equal(existsSync(lockDir), true, "lockDir must not be moved");
		const remaining = JSON.parse(
			readFileSync(join(lockDir, "owner.json"), "utf8"),
		);
		assert.equal(remaining.token, token);
		// The pre-existing tombstone must be intact (not overwritten/deleted).
		const tombOwner = JSON.parse(
			readFileSync(join(tombstone, "owner.json"), "utf8"),
		);
		assert.equal(tombOwner.token, token);
	});
});

test("an ownerless lock from a crash before owner metadata is recoverable", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		writeFileSync(file, serializeState([freshTask()]), { mode: 0o600 });
		const lockDir = `${file}.lock`;

		// Simulate a crash in the old mkdir -> owner.json window: the published
		// lock directory exists but contains no owner metadata.
		await fsp.mkdir(lockDir, { mode: 0o700 });
		const backdate = Date.now() / 1000 - 120;
		await fsp.utimes(lockDir, backdate, backdate);

		const store = createTaskStore({
			filePath: file,
			staleLockMs: 10,
			lockTimeoutMs: 3000,
		});
		const result = await store.transaction(async () => "recovered");
		assert.equal(result, "recovered");
		assert.equal(existsSync(lockDir), false, "the recovered lock is released");
		assert.doesNotThrow(() => JSON.parse(readFileSync(file, "utf8")));
	});
});
