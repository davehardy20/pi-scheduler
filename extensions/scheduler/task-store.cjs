const { promises: fs, constants } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_STALE_LOCK_MS = 30000;
const STATE_VERSION = 2;

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

async function readJsonIfExists(filePath) {
	let raw;
	try {
		raw = await fs.readFile(filePath, "utf8");
	} catch (error) {
		if (error.code === "ENOENT")
			return { version: STATE_VERSION, updatedAt: undefined, tasks: [] };
		throw error;
	}
	const parsed = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tasks)) {
		throw new Error(
			"Malformed scheduler state: expected object with tasks array",
		);
	}
	return parsed;
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

	async function acquireLock() {
		const token = crypto.randomBytes(32).toString("hex");
		const deadline = Date.now() + lockTimeoutMs;
		let delay = 8;
		await ensureStateDirectory(path.dirname(filePath));

		while (true) {
			try {
				await fs.mkdir(lockDir, { mode: 0o700 });
				await chmodOwnerOnly(lockDir, 0o700);
				const owner = {
					pid: process.pid,
					token,
					createdAt: new Date().toISOString(),
				};
				await fs.writeFile(
					path.join(lockDir, "owner.json"),
					`${JSON.stringify(owner)}\n`,
					{ mode: 0o600, flag: "wx" },
				);
				return { token };
			} catch (error) {
				if (error.code !== "EEXIST") throw error;
			}

			const now = Date.now();
			let stale = false;
			try {
				const stat = await fs.stat(lockDir);
				const owner = await readLockOwner(lockDir);
				const age = now - stat.mtimeMs;
				const alive = isProcessAlive(owner?.pid);
				stale = age > staleLockMs && alive !== true;
			} catch (error) {
				if (error.code === "ENOENT") continue;
				throw error;
			}

			if (stale) {
				const recovery = `${lockDir}.stale-${process.pid}-${token}`;
				try {
					await fs.rename(lockDir, recovery);
					await fs.rm(recovery, { recursive: true, force: true });
					continue;
				} catch (error) {
					if (
						!["ENOENT", "EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(
							error.code,
						)
					)
						throw error;
				}
			}

			if (Date.now() >= deadline)
				throw new Error(`Scheduler store lock timeout for ${filePath}`);
			await sleep(Math.min(delay, Math.max(1, deadline - Date.now())));
			delay = Math.min(50, Math.floor(delay * 1.5) + 1);
		}
	}

	async function releaseLock(lock) {
		const owner = await readLockOwner(lockDir);
		if (owner?.pid === process.pid && owner?.token === lock.token) {
			await fs.rm(lockDir, { recursive: true, force: true });
		}
	}

	async function transaction(fn) {
		const lock = await acquireLock();
		try {
			const state = await readJsonIfExists(filePath);
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
		};
	}

	async function completeClaimedTask({
		taskId,
		runnerId,
		claimToken,
		result,
		now = new Date(),
		ok = true,
	} = {}) {
		if (!taskId) throw new Error("taskId is required");
		if (!runnerId) throw new Error("runnerId is required");
		if (!claimToken) throw new Error("claimToken is required");
		const nowDate = toDate(now, "now");
		let completed;

		await transaction((tasks) => {
			const task = tasks.find((item) => item && item.id === taskId);
			if (!task) throw new Error(`Scheduled task not found: ${taskId}`);
			if (task.runnerId !== String(runnerId))
				throw new Error("Claim runner identity mismatch");
			if (task.claimToken !== claimToken)
				throw new Error("Claim token mismatch");
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
			if (task.type === "once" || ok === false || reachedMaxRuns) {
				task.enabled = false;
				task.status = ok === false ? "failed" : "fired";
				if (ok === false) task.failedAt = nowDate.toISOString();
				else task.firedAt = nowDate.toISOString();
				task.nextRun = undefined;
			} else {
				task.status = "pending";
				task.enabled = true;
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
				} else {
					task.nextRun = undefined;
				}
			}
			completed = { ...task };
		});

		return completed;
	}

	return { transaction, claimDueTask, completeClaimedTask };
}

module.exports = { createTaskStore };
