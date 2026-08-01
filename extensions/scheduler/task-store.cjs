const { promises: fs, constants } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_STALE_LOCK_MS = 30000;
const STATE_VERSION = 2;

// Warn callback default: surfaced warnings are opt-in so a plain store does
// not write to stderr. Callers (the runtime) pass onWarning to surface
// malformed-state recovery to the user.
function defaultWarning() {
	// intentionally no-op; callers provide onWarning.
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function toDate(value, name) {
	const date =
		value instanceof Date
			? new Date(value.getTime())
			: new Date(value ?? Date.now());
	if (!Number.isFinite(date.getTime()))
		throw new Error(`Invalid ${name || "date"}`);
	return date;
}

function isProcessAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error && error.code === "EPERM";
	}
}

async function chmodOwnerOnly(target, mode) {
	try {
		await fs.chmod(target, mode);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}

async function ensureStateDirectory(dir) {
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	await chmodOwnerOnly(dir, 0o700);
}

/**
 * Read and parse the persisted state. A missing file is the normal empty
 * state. Malformed JSON or a wrong-shape object is treated as CORRUPT state:
 * the raw file is quarantined to a timestamped, restrictive backup and
 * recovery proceeds EMPTY with a surfaced warning. This never throws on
 * malformed input — it quarantines and returns empty so a corrupt file does
 * not crash startup or get silently overwritten.
 *
 * @param {string} filePath
 * @param {object} lockCtx  carries the owner token + timestamp used to name
 *   quarantine backups deterministically without a second clock read.
 * @param {(message: string) => void} onWarning  surfaced when state is reset.
 * @returns {Promise<{version:number, updatedAt:string|undefined, tasks:Array}>}
 */
async function readJsonIfExists(filePath, lockCtx, onWarning) {
	let raw;
	try {
		raw = await fs.readFile(filePath, "utf8");
	} catch (error) {
		if (error.code === "ENOENT")
			return { version: STATE_VERSION, updatedAt: undefined, tasks: [] };
		throw error;
	}
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tasks)) {
			throw new Error(
				"Malformed scheduler state: expected object with tasks array",
			);
		}
		return parsed;
	} catch (_error) {
		// Quarantine the corrupt file and recover empty. Fail-closed: a bad file
		// never widens execution or silently overwrites state.
		await quarantineCorruptState(filePath, raw, lockCtx, onWarning);
		return { version: STATE_VERSION, updatedAt: undefined, tasks: [] };
	}
}

/**
 * Move a corrupt state file to a timestamped, owner-only backup so the user
 * can inspect what went wrong, then surface a warning. The original path is
 * removed so the next write starts fresh.
 */
async function quarantineCorruptState(filePath, raw, lockCtx, onWarning) {
	const warn = onWarning || defaultWarning;
	const stamp = new Date().toISOString().replace(/[^0-9]/g, "");
	const suffix = `${stamp}-${process.pid}-${lockCtx?.token || crypto.randomBytes(4).toString("hex")}`;
	const backup = `${filePath}.malformed-${suffix}`;
	try {
		// Copy then remove: rename would lose the backup if the target exists on
		// some platforms; an explicit copy keeps the raw bytes for inspection.
		await fs.writeFile(backup, raw ?? "", { mode: 0o600 });
		await chmodOwnerOnly(backup, 0o600);
		await fs.unlink(filePath).catch((error) => {
			if (error.code !== "ENOENT") throw error;
		});
		warn(
			`Scheduled task state at ${filePath} was malformed and has been quarantined to ${backup}; recovering with an empty task list. Inspect the backup to recover any tasks.`,
		);
	} catch (error) {
		// Even if quarantine fails, do not crash: surface the problem and
		// proceed empty so the store stays usable.
		warn(
			`Scheduled task state at ${filePath} was malformed and could not be quarantined (${error?.code ? error.code : "error"}); recovering with an empty task list.`,
		);
	}
}

async function fsyncPath(filePath) {
	let handle;
	try {
		handle = await fs.open(filePath, constants.O_RDONLY);
		await handle.sync();
	} catch (error) {
		// Directory fsync is not supported on every platform/filesystem. The
		// write+rename remains atomic; rethrow only non-portability surprises.
		if (!["EINVAL", "EISDIR", "EPERM", "EACCES", "ENOENT"].includes(error.code))
			throw error;
	} finally {
		await handle?.close().catch(() => {});
	}
}

async function writeStateAtomic(filePath, state, ownerToken) {
	const dir = path.dirname(filePath);
	await ensureStateDirectory(dir);
	const tmp = path.join(
		dir,
		`.${path.basename(filePath)}.${process.pid}.${ownerToken}.${crypto.randomBytes(8).toString("hex")}.tmp`,
	);
	const data = `${JSON.stringify(state)}\n`;
	let handle;
	try {
		handle = await fs.open(
			tmp,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
			0o600,
		);
		await handle.writeFile(data, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fs.rename(tmp, filePath);
		await chmodOwnerOnly(filePath, 0o600);
		await fsyncPath(dir);
	} catch (error) {
		await handle?.close().catch(() => {});
		await fs.rm(tmp, { force: true }).catch(() => {});
		throw error;
	}
}

async function readLockOwner(lockDir) {
	try {
		const raw = await fs.readFile(path.join(lockDir, "owner.json"), "utf8");
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

/**
 * Build a deterministic fingerprint of the observed lock owner and directory
 * identity. Valid owners use token + inode. An ownerless lock (possible if a
 * process dies between mkdir and owner.json write) uses the stronger available
 * directory identity tuple so it can still be recovered without weakening the
 * replacement check for normal live locks.
 */
async function fingerprintLock(lockDir, now) {
	let stat;
	try {
		stat = await fs.stat(lockDir);
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
	const owner = await readLockOwner(lockDir);
	let entryCount;
	try {
		entryCount = (await fs.readdir(lockDir)).length;
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
	return {
		pid: owner?.pid,
		token: owner?.token,
		createdAt: owner?.createdAt,
		dev: stat.dev,
		ino: stat.ino,
		mtimeMs: stat.mtimeMs,
		ctimeMs: stat.ctimeMs,
		birthtimeMs: stat.birthtimeMs,
		entryCount,
		observedAt: now,
	};
}

function sameFingerprint(a, b) {
	if (!a || !b) return false;
	const aHasToken = typeof a.token === "string" && a.token.length > 0;
	const bHasToken = typeof b.token === "string" && b.token.length > 0;
	if (aHasToken || bHasToken) {
		if (!aHasToken || !bHasToken || a.token !== b.token) return false;
		if (a.ino && b.ino) return a.dev === b.dev && a.ino === b.ino;
		return a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
	}

	// Both observations are ownerless. Require the full stable directory tuple;
	// a newly created live lock cannot match merely because an inode was reused.
	return (
		Boolean(a.ino) &&
		Boolean(b.ino) &&
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.mtimeMs === b.mtimeMs &&
		a.ctimeMs === b.ctimeMs &&
		a.birthtimeMs === b.birthtimeMs
	);
}

function createTaskStore(options = {}) {
	if (!options.filePath) throw new Error("filePath is required");
	const filePath = path.resolve(String(options.filePath));
	const lockDir = `${filePath}.lock`;
	const lockTimeoutMs = Math.max(
		1,
		Number(options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS),
	);
	const staleLockMs = Math.max(
		1,
		Number(options.staleLockMs ?? DEFAULT_STALE_LOCK_MS),
	);
	const onWarning =
		typeof options.onWarning === "function"
			? options.onWarning
			: defaultWarning;
	// Test-only hook: called (awaitable) right after a reclaimer observes a
	// stale owner, BEFORE it re-reads and atomically renames lockDir to the
	// tombstone. Used by the deterministic race regression tests to pause a
	// delayed reclaimer on either side of the atomic rename.
	const staleReapHook =
		typeof options.staleReapHook === "function"
			? options.staleReapHook
			: undefined;
	// Test-only hook for the RELEASE path: called (awaitable) during lock
	// release so a deterministic test can pause the old owner AFTER the atomic
	// rename of lockDir to its release quarantine (and AFTER the moved-owner
	// identity verify) but BEFORE the quarantine cleanup. This is the exact
	// window the original in-place recursive-rm release exploited: a new owner
	// could acquire lockDir while the old owner's rm was still mid-flight.
	const releaseLockHook =
		typeof options.releaseLockHook === "function"
			? options.releaseLockHook
			: undefined;

	/**
	 * Deterministic, crash-safe tombstone name for an observed stale owner.
	 * Keyed by the observed random owner token (owner identity), with a
	 * fallback to the inode fingerprint when the token is absent. The name is
	 * STABLE across reclaimers observing the SAME dead owner, so two
	 * reclaimers race on the SAME destination and POSIX rename() serializes
	 * them: the winner moves lockDir aside, the loser fails with ENOTEMPTY
	 * because the (non-empty) tombstone already exists.
	 */
	function tombstoneNameFor(observed) {
		const key =
			observed && typeof observed.token === "string" && observed.token
				? observed.token
				: `ownerless-${observed?.dev ?? "nodev"}-${observed?.ino ?? "noino"}-${observed?.mtimeMs ?? "nomtime"}-${observed?.ctimeMs ?? "noctime"}`;
		return `${lockDir}.tombstone-${String(key).replace(/[^a-zA-Z0-9]/g, "_")}`;
	}

	/**
	 * Ownership-safe, CRASH-SAFE stale-lock recovery via a persistent owner
	 * tombstone quarantine. The design replaces the older per-owner reaper
	 * guard, which was NOT crash-safe: a reclaimer that crashed after creating
	 * its guard directory left a marker that every later reclaimer for that
	 * exact dead owner hit as EEXIST and backed off FOREVER, permanently
	 * blocking recovery of the dead lock (a critical availability flaw).
	 *
	 * New contract (single atomic step is the whole act):
	 *   1. Re-read lockDir and require the EXACT observed owner/fingerprint.
	 *      If the owner changed (a live owner now holds it), REFUSE to act.
	 *   2. Re-confirm the owner process is dead right before acting.
	 *   3. ATOMICALLY rename lockDir -> a deterministic tombstone keyed by the
	 *      OBSERVED owner token (or inode when token is absent). This single
	 *      rename is the entire act.
	 *   4. Verify the moved tombstone's owner matches the observed one.
	 *
	 * Crash safety, proven from the single atomic rename:
	 *   - Crash BEFORE rename: lockDir is still present. Another reclaimer
	 *     re-observes the SAME dead owner and tries the SAME deterministic
	 *     rename; recovery proceeds. No state is lost.
	 *   - Crash AFTER rename: lockDir is gone (a new live owner can acquire
	 *     immediately) and the tombstone is preserved on disk. Recovery is
	 *     complete; no further work is required and nothing is blocked.
	 *
	 * Delayed-reclaimer race safety (the original bug):
	 *   - A delayed reclaimer that observed dead owner X, and runs after
	 *     another reclaimer already reaped X, attempts rename(lockDir ->
	 *     tombstone-X). Because tombstone-X is NON-EMPTY (it contains the
	 *     reaped owner.json), POSIX rename fails with ENOTEMPTY instead of
	 *     overwriting it. The delayed reclaimer backs off. It can therefore
	 *     NEVER rename a new live owner C's lock onto the existing X
	 *     tombstone, even though C's live lock now occupies lockDir.
	 *
	 * Tombstones are NEVER automatically deleted. Auto-deleting them would
	 * reopen the delayed-reclaimer race: if a delayed reclaimer for old owner
	 * X ran after the tombstone was deleted, its rename(lockDir -> tombstone-X)
	 * would succeed against whatever live lock now occupies lockDir. Keeping a
	 * bounded number of restrictive, owner-only tombstones (one per distinct
	 * dead owner token, which is a 256-bit random id) is the price of closing
	 * the race. A tombstone is a stale, harmless artifact; it is never read
	 * for execution and is owner-only (0o700). Users may remove old
	 * `*.tombstone-*` directories manually once they are certain no
	 * long-delayed reclaimer for that owner can still run.
	 */
	async function reapStaleLock(observed, _token) {
		// Optional test barrier: pause here so a delayed reclaimer can be
		// deterministically interleaved with a real reaper and a live owner. The
		// hook fires right after the stale observation and BEFORE the re-read /
		// atomic rename, mirroring the window the original race exploited.
		if (staleReapHook) await staleReapHook(observed, "before-reread");

		// RE-READ and require the EXACT observed fingerprint before acting. If
		// the owner changed (a live owner now holds lockDir) we must NOT move
		// or touch it.
		const current = await fingerprintLock(lockDir, Date.now());
		if (!current || !sameFingerprint(observed, current)) {
			return { reaped: false, changed: true };
		}

		// Re-confirm the owner process is still dead right before acting, so we
		// never reap a lock whose owner came back to life.
		const alive = isProcessAlive(current.pid);
		if (alive === true) {
			return { reaped: false, alive: true };
		}

		// Optional test barrier on the OTHER side of the re-read: pause right
		// before the atomic rename so a crash-at-this-point test can prove the
		// tombstone is NOT created and lockDir is still present for another
		// reclaimer.
		if (staleReapHook) await staleReapHook(observed, "before-rename");

		// Legacy ownerless locks may be empty (crash after mkdir, before owner
		// metadata). New acquisitions publish a non-empty candidate atomically, so
		// rmdir is safe here: it succeeds only while the exact stale directory is
		// still empty. If a complete live lock replaced it, rmdir fails ENOTEMPTY.
		const hasOwnerToken =
			typeof current.token === "string" && current.token.length > 0;
		if (!hasOwnerToken && current.entryCount === 0) {
			try {
				await fs.rmdir(lockDir);
				return { reaped: true, ownerless: true };
			} catch (error) {
				if (error.code === "ENOENT" || error.code === "ENOTEMPTY")
					return { reaped: false, changed: true };
				throw error;
			}
		}

		// THE act: atomically rename lockDir to the deterministic tombstone for
		// the observed owner. POSIX rename() of a non-empty directory over an
		// existing NON-EMPTY directory fails with ENOTEMPTY, so a delayed
		// reclaimer for an owner that was already reaped cannot overwrite the
		// preserved tombstone.
		const tombstone = tombstoneNameFor(observed);
		try {
			await fs.rename(lockDir, tombstone);
		} catch (error) {
			if (error.code === "ENOENT") {
				// lockDir is gone: another reclaimer already reaped it. Nothing to
				// do; the lock is free for acquisition.
				return { reaped: false, gone: true };
			}
			if (error.code === "ENOTEMPTY" || error.code === "EEXIST") {
				// The deterministic tombstone for THIS observed owner already
				// exists and is non-empty: another reclaimer already reaped this
				// owner. Back off. We deliberately do NOT delete or overwrite the
				// tombstone (that would reopen the delayed-reclaimer race).
				return { reaped: false, tombstone: true };
			}
			throw error;
		}

		// Ensure the restrictive, owner-only permissions survive the move.
		await chmodOwnerOnly(tombstone, 0o700);

		// Verify the moved tombstone's owner matches the observed one. This is a
		// defense-in-depth check; the pre-rename fingerprint+alive checks make a
		// mismatch essentially impossible. If it happens, preserve the artifact
		// AT THE DETERMINISTIC TOMBSTONE PATH. Moving or deleting that path would
		// reopen the delayed-reclaimer race by allowing another stale observer to
		// rename a new live lock onto the now-vacant destination.
		const quarantined = await readLockOwner(tombstone);
		if (
			!quarantined ||
			quarantined.token !== observed.token ||
			Number(quarantined.pid) !== Number(observed.pid)
		) {
			onWarning(
				`Scheduler lock recovery moved ${lockDir}, but the quarantined owner did not match the observed stale owner. The artifact remains preserved at ${tombstone}; it was not deleted, moved, or restored.`,
			);
			return { reaped: true, mismatch: true, tombstone };
		}

		return { reaped: true, tombstone };
	}

	async function acquireLock() {
		const token = crypto.randomBytes(32).toString("hex");
		const deadline = Date.now() + lockTimeoutMs;
		let delay = 8;
		await ensureStateDirectory(path.dirname(filePath));

		// Build a complete, non-empty lock candidate before publishing it at
		// lockDir. The atomic rename removes the mkdir -> owner.json crash window:
		// every new lock is visible with owner metadata already present. On POSIX
		// this can also atomically replace a legacy empty ownerless lock.
		const candidateDir = `${lockDir}.candidate-${process.pid}-${token}`;
		await fs.mkdir(candidateDir, { mode: 0o700 });
		try {
			await chmodOwnerOnly(candidateDir, 0o700);
			const owner = {
				pid: process.pid,
				token,
				createdAt: new Date().toISOString(),
			};
			await fs.writeFile(
				path.join(candidateDir, "owner.json"),
				`${JSON.stringify(owner)}\n`,
				{ mode: 0o600, flag: "wx" },
			);

			while (true) {
				try {
					await fs.rename(candidateDir, lockDir);
					return { token };
				} catch (error) {
					if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
				}

				const now = Date.now();
				let observed;
				try {
					observed = await fingerprintLock(lockDir, now);
				} catch (error) {
					if (error.code === "ENOENT") continue;
					throw error;
				}

				const age = observed ? now - observed.mtimeMs : 0;
				const alive = observed ? isProcessAlive(observed.pid) : undefined;
				const stale = observed && age > staleLockMs && alive !== true;

				if (stale) {
					const result = await reapStaleLock(observed, token);
					if (result?.reaped) continue;
					if (Date.now() >= deadline)
						throw new Error(`Scheduler store lock timeout for ${filePath}`);
					await sleep(Math.min(delay, Math.max(1, deadline - Date.now())));
					delay = Math.min(50, Math.floor(delay * 1.5) + 1);
					continue;
				}

				if (Date.now() >= deadline)
					throw new Error(`Scheduler store lock timeout for ${filePath}`);
				await sleep(Math.min(delay, Math.max(1, deadline - Date.now())));
				delay = Math.min(50, Math.floor(delay * 1.5) + 1);
			}
		} finally {
			// On success candidateDir was renamed away. On timeout/error, remove the
			// unpublished candidate so failed acquisitions leave no artifact.
			await fs
				.rm(candidateDir, { recursive: true, force: true })
				.catch(() => {});
		}
	}

	/**
	 * Release the lock owned by `lock` using an OWNERSHIP-SAFE, race-free
	 * atomic quarantine. This replaces the old in-place recursive fs.rm(lockDir),
	 * which had a release race: between the ownership read and the completion of
	 * the recursive rm, lockDir could be ACQUIRED by a new live owner, and the
	 * old owner's recursive rm would then delete the new owner's LIVE lock
	 * (allowing a third contender to interleave writes and lose updates).
	 *
	 * Atomic, race-free release:
	 *   1. Confirm ownership of the CURRENT lockDir (pid + token).
	 *   2. ATOMICALLY rename lockDir -> a unique TOKEN-BOUND release quarantine.
	 *      After this single rename lockDir is FREE for a new owner to acquire;
	 *      the old owner never touches lockDir again.
	 *   3. chmod the quarantine owner-only (0o700).
	 *   4. Verify the MOVED quarantine owner still matches. On mismatch, PRESERVE
	 *      the quarantine and warn (defense-in-depth; the ownership pre-check
	 *      makes a mismatch essentially impossible). Never restore/revisit it.
	 *   5. Delete ONLY the release quarantine. A cleanup failure only WARNS: the
	 *      transaction is already committed and the lock is already released,
	 *      so a leftover restrictive quarantine is a harmless stale artifact.
	 *
	 * ENOENT on the rename is benign (another release/reaper already vacated
	 * lockDir); nothing is left to clean up. This never deletes or revisits
	 * lockDir after the rename, and preserves the existing stale-tombstone
	 * recovery semantics for dead locks.
	 */
	function releaseQuarantineNameFor(ownerToken) {
		const key =
			typeof ownerToken === "string" && ownerToken
				? ownerToken
				: `release-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
		return `${lockDir}.release-${String(key).replace(/[^a-zA-Z0-9]/g, "_")}`;
	}

	async function releaseLock(lock) {
		const owner = await readLockOwner(lockDir);
		if (owner?.pid !== process.pid || owner?.token !== lock.token) return;

		const releaseDir = releaseQuarantineNameFor(owner.token);
		try {
			await fs.rename(lockDir, releaseDir);
		} catch (error) {
			// lockDir is already gone: another release or a stale reaper vacated
			// it. The lock is effectively released; nothing remains to clean up.
			if (error.code === "ENOENT") return;
			throw error;
		}

		// Ensure restrictive owner-only permissions survive the move.
		await chmodOwnerOnly(releaseDir, 0o700);

		// Verify the MOVED quarantine owner still matches. A mismatch is
		// defense-in-depth; the pre-rename ownership check makes it essentially
		// impossible. If it happens, PRESERVE the artifact at the release
		// quarantine path and warn. Never restore, delete, or revisit lockDir.
		let mismatch = false;
		const quarantined = await readLockOwner(releaseDir);
		if (
			!quarantined ||
			quarantined.token !== owner.token ||
			Number(quarantined.pid) !== Number(owner.pid)
		) {
			mismatch = true;
			onWarning(
				`Scheduler lock release for ${lockDir} moved the lock to ${releaseDir}, but the quarantined owner did not match the releasing owner. The artifact remains preserved at ${releaseDir}; it was not deleted, moved, or restored.`,
			);
		}

		// Optional test barrier: pause AFTER the atomic rename and identity
		// verify, BEFORE cleanup. This is the window the original in-place
		// recursive-rm race exploited (lockDir vacated but cleanup pending).
		if (releaseLockHook)
			await releaseLockHook({ releaseDir, mismatch }, "before-cleanup");

		// Delete ONLY the release quarantine. lockDir is no longer this owner's
		// concern (it was vacated by the rename and may already be a new live
		// owner's lock). A cleanup failure only WARNS: the transaction is
		// already committed and the lock is already released, so a leftover
		// restrictive quarantine is a harmless stale artifact.
		if (mismatch) return;
		try {
			await fs.rm(releaseDir, { recursive: true, force: true });
		} catch (error) {
			if (error.code === "ENOENT") return;
			onWarning(
				`Scheduler lock release cleaned up the lock for ${lockDir} but could not remove the release quarantine at ${releaseDir} (${error?.code ? error.code : "error"}); the transaction is already committed.`,
			);
		}
	}

	async function transaction(fn) {
		const lock = await acquireLock();
		try {
			const state = await readJsonIfExists(filePath, lock, onWarning);
			const tasks = state.tasks;
			const result = await fn(tasks, state);
			const nextState = {
				...state,
				version: state.version ?? STATE_VERSION,
				updatedAt: new Date().toISOString(),
				tasks,
			};
			await writeStateAtomic(filePath, nextState, lock.token);
			return result;
		} finally {
			await releaseLock(lock);
		}
	}

	async function claimDueTask({
		runnerId,
		now = new Date(),
		leaseMs = 60000,
		taskId,
	} = {}) {
		if (!runnerId) throw new Error("runnerId is required");
		const nowDate = toDate(now, "now");
		const nowMs = nowDate.getTime();
		const claimToken = crypto.randomBytes(32).toString("hex");
		const leaseExpiresAt = new Date(
			nowMs + Math.max(1, Number(leaseMs)),
		).toISOString();
		let claimedTask;

		await transaction((tasks) => {
			for (const task of tasks) {
				if (
					!task ||
					task.enabled === false ||
					["fired", "cancelled", "failed"].includes(task.status)
				)
					continue;
				// When a specific task id is requested (e.g. its in-process timer
				// fired), only that task is eligible. Without an id, any due task
				// may be claimed (used by recovery sweeps).
				if (taskId !== undefined && task.id !== taskId) continue;
				const claimExpiresMs = Date.parse(task.claimLeaseExpiresAt ?? "");
				const hasLiveClaim =
					task.status === "running" &&
					Number.isFinite(claimExpiresMs) &&
					claimExpiresMs > nowMs;
				if (hasLiveClaim) continue;
				const dueMs = Date.parse(task.nextRun ?? task.dueAt ?? "");
				if (!Number.isFinite(dueMs) || dueMs > nowMs) continue;

				task.status = "running";
				task.lastStatus = "running";
				task.startedAt = nowDate.toISOString();
				task.claimedAt = nowDate.toISOString();
				task.runnerId = String(runnerId);
				task.claimToken = claimToken;
				task.claimLeaseExpiresAt = leaseExpiresAt;
				// Record a mutation generation at claim time so a later
				// cancel/disable/remove during the run can bump it; completion
				// refuses to resurrect a task whose generation advanced.
				task.claimGeneration =
					(Number.isInteger(task.claimGeneration) ? task.claimGeneration : 0) +
					1;
				claimedTask = { ...task };
				break;
			}
		});

		if (!claimedTask) return { claimed: false };
		return {
			claimed: true,
			task: claimedTask,
			runnerId: String(runnerId),
			claimToken,
			leaseExpiresAt,
			claimGeneration: claimedTask.claimGeneration,
		};
	}

	/**
	 * Decide a task's fate after a claimed run, honoring terminal/disabled
	 * state set DURING the run (cancellation/disable). A task that became
	 * terminal or disabled while this runner held the claim is left in that
	 * state: completion must NOT resurrect it.
	 *
	 * Failure semantics (lead review high fix 1):
	 *   - a FAILED `once` task is terminal (failed) — unchanged.
	 *   - a FAILED interval/cron task STAYS enabled+pending and schedules its
	 *     next run, UNLESS maxRuns has been reached.
	 *   - a SUCCESSFUL once task or any task that reached maxRuns is terminal.
	 *   - a SUCCESSFUL interval/cron task stays pending with its next run.
	 */
	function settleTaskAfterRun(task, nowDate, ok, result, _claimedGeneration) {
		// If the task was cancelled/removed-then-rescheduled/disabled during the
		// run (its terminal/disabled state advanced past the claim), respect it.
		// We detect a concurrent terminal transition by checking the current
		// status: only a still-running (or pending) task owned by this claim may
		// be advanced. A task already cancelled/failed/fired is left as-is.
		const alreadyTerminal =
			task.status === "cancelled" ||
			task.status === "failed" ||
			task.status === "fired";
		if (alreadyTerminal) {
			// Still clear claim metadata and record the run, but keep the terminal
			// state and do not schedule a next run.
			task.runCount =
				(Number.isInteger(task.runCount) && task.runCount >= 0
					? task.runCount
					: 0) + 1;
			task.lastRun = nowDate.toISOString();
			task.lastStatus = ok === false ? "error" : "success";
			if (result !== undefined) task.result = result;
			delete task.claimToken;
			delete task.runnerId;
			delete task.claimLeaseExpiresAt;
			task.nextRun = undefined;
			return;
		}

		// If the task was DISABLED during the run, keep it disabled: do not
		// re-enable or schedule a next run. Record the run outcome.
		const disabledDuringRun = task.enabled === false;

		task.runCount =
			(Number.isInteger(task.runCount) && task.runCount >= 0
				? task.runCount
				: 0) + 1;
		task.lastRun = nowDate.toISOString();
		task.lastStatus = ok === false ? "error" : "success";
		if (result !== undefined) task.result = result;
		delete task.claimToken;
		delete task.runnerId;
		delete task.claimLeaseExpiresAt;

		const reachedMaxRuns =
			task.maxRuns !== undefined && task.runCount >= task.maxRuns;

		// once tasks are always terminal (success -> fired, failure -> failed).
		// Any task that reached maxRuns is terminal. If disabled during the run,
		// keep it disabled and do not reschedule.
		if (task.type === "once" || reachedMaxRuns || disabledDuringRun) {
			task.enabled = false;
			if (ok === false) {
				task.status = "failed";
				task.failedAt = nowDate.toISOString();
			} else {
				task.status = disabledDuringRun ? task.status : "fired";
				if (!disabledDuringRun) task.firedAt = nowDate.toISOString();
			}
			task.nextRun = undefined;
			return;
		}

		// Recurring (interval/cron) task. A FAILURE no longer terminates it: it
		// stays enabled+pending and schedules its next run. Same for success.
		task.enabled = true;
		task.status = "pending";
		if (
			task.type === "interval" &&
			Number.isFinite(Number(task.intervalMs)) &&
			Number(task.intervalMs) > 0
		) {
			const nextRun = new Date(
				nowDate.getTime() + Number(task.intervalMs),
			).toISOString();
			task.nextRun = nextRun;
			task.dueAt = nextRun;
		} else if (task.type === "cron") {
			// Recompute the next cron run from now using croner, if available.
			try {
				const { Cron } = require("croner");
				const cron = new Cron(task.schedule, { paused: true }, () => {});
				const next = cron.nextRun(nowDate);
				cron.stop();
				if (next) {
					task.nextRun = next.toISOString();
					task.dueAt = next.toISOString();
				} else {
					// No further cron runs: terminal.
					task.enabled = false;
					task.status = ok === false ? "failed" : "fired";
					task.nextRun = undefined;
				}
			} catch {
				// Invalid cron at completion: fail closed (terminal) so it is not
				// retried indefinitely with no schedule.
				task.enabled = false;
				task.status = ok === false ? "failed" : "fired";
				task.nextRun = undefined;
			}
		} else {
			task.nextRun = undefined;
		}
	}

	async function completeClaimedTask({
		taskId,
		runnerId,
		claimToken,
		result,
		now = new Date(),
		ok = true,
		claimGeneration,
	} = {}) {
		if (!taskId) throw new Error("taskId is required");
		if (!runnerId) throw new Error("runnerId is required");
		if (!claimToken) throw new Error("claimToken is required");
		const nowDate = toDate(now, "now");
		let completed;

		await transaction((tasks) => {
			const task = tasks.find((item) => item && item.id === taskId);
			if (!task) throw new Error(`Scheduled task not found: ${taskId}`);
			// Ownership check: only the claim owner may complete. A task whose
			// claim was already recovered (lease expired) will have a different
			// (or absent) runnerId/token and is rejected.
			if (task.runnerId !== String(runnerId))
				throw new Error("Claim runner identity mismatch");
			if (task.claimToken !== claimToken)
				throw new Error("Claim token mismatch");
			settleTaskAfterRun(task, nowDate, ok, result, claimGeneration);
			completed = { ...task };
		});

		return completed;
	}

	/**
	 * Abandon a claim WITHOUT completing the task as fired/failed. Clears the
	 * claim metadata (runnerId, claimToken, claimLeaseExpiresAt) and restores
	 * the task to pending so a future eligible run can claim it again. The
	 * runCount is NOT incremented: no execution happened.
	 *
	 * Ownership/token contract (same as completeClaimedTask): only the claim
	 * owner may abandon its own claim. A runner that does not hold the claim
	 * (wrong runnerId or wrong token) is rejected so it cannot release
	 * another runner's claim. This is the safe counterpart to a no-op
	 * release: the task stays pending, not fired.
	 *
	 * Used by the integration layer to release a claim for a task it must not
	 * execute (e.g. an out-of-scope task) without falsely marking it fired.
	 */
	async function abandonClaimedTask({
		taskId,
		runnerId,
		claimToken,
		now = new Date(),
	} = {}) {
		if (!taskId) throw new Error("taskId is required");
		if (!runnerId) throw new Error("runnerId is required");
		if (!claimToken) throw new Error("claimToken is required");
		const nowDate = toDate(now, "now");
		let abandoned;

		await transaction((tasks) => {
			const task = tasks.find((item) => item && item.id === taskId);
			if (!task) throw new Error(`Scheduled task not found: ${taskId}`);
			if (task.runnerId !== String(runnerId))
				throw new Error("Claim runner identity mismatch");
			if (task.claimToken !== claimToken)
				throw new Error("Claim token mismatch");

			// Snapshot concurrent lifecycle state before clearing claim metadata. A
			// cancellation/disable may race the release path while this runner still
			// owns the token. Abandonment must release the lease without resurrecting
			// that newer terminal/disabled decision.
			const terminalOrDisabled =
				task.enabled === false ||
				task.status === "cancelled" ||
				task.status === "failed" ||
				task.status === "fired";

			delete task.claimToken;
			delete task.runnerId;
			delete task.claimLeaseExpiresAt;

			if (terminalOrDisabled) {
				task.nextRun = undefined;
				if (task.lastStatus === "running") delete task.lastStatus;
				abandoned = { ...task };
				return;
			}

			// No concurrent lifecycle mutation occurred: restore to pending.
			// runCount is intentionally unchanged because no execution happened.
			task.status = "pending";
			task.enabled = true;
			if (task.lastStatus === "running") delete task.lastStatus;

			// For interval tasks, recompute nextRun from now so an out-of-scope
			// release does not immediately re-enter the same claim/release loop.
			// Cron/once keep their existing schedule for the next eligible runner.
			if (task.type === "interval") {
				const intervalMs = Number(task.intervalMs);
				if (Number.isFinite(intervalMs) && intervalMs > 0) {
					const nextRun = new Date(
						nowDate.getTime() + intervalMs,
					).toISOString();
					task.nextRun = nextRun;
					task.dueAt = nextRun;
				}
			}

			abandoned = { ...task };
		});

		return abandoned;
	}

	return {
		transaction,
		claimDueTask,
		completeClaimedTask,
		abandonClaimedTask,
		// Exposed for targeted unit testing of the recovery seam only.
		_reapStaleLock: reapStaleLock,
		_tombstoneNameFor: tombstoneNameFor,
		_releaseQuarantineNameFor: releaseQuarantineNameFor,
	};
}

module.exports = { createTaskStore };
