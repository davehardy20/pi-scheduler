// Contracts for fresh, validated loading of the scheduler execution policy.
//
// Lead review found that the first integration pass CACHED the execution policy
// for the whole session, so a policy revocation/edit was NOT re-read at firing
// time. These tests pin the REQUIRED behavior introduced for Seeds child
// pi-scheduler-6392:
//
//   * loadPolicyFromFile re-reads, re-validates, and re-parses on EVERY call
//     (no session-wide cache) so an edit/revocation takes effect immediately.
//   * a missing file is the normal deny-by-default state.
//   * the file must be a REGULAR user-owned file; a symlink/pipe/socket is
//     rejected and fails closed.
//   * group- or world-writable POSIX mode is rejected (recommend chmod 600).
//   * a file owned by another user is rejected.
//   * malformed JSON fails closed rather than widening execution.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	mkdtempSync,
	rmSync,
	writeFileSync,
	symlinkSync,
	chmodSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const ROOT = join(__dirname, "..", "extensions", "scheduler");
const {
	loadPolicyFromFile,
	loadPolicyConfig,
	openAndStatPolicyFile,
	validateOpenedPolicyIdentity,
	validatePolicyPathBeforeOpen,
} = require(join(ROOT, "execution-policy.cjs"));

const ALLOW_CONFIG = {
	execution: {
		enabled: true,
		allow: [{ executable: "npm", argvPrefix: ["test"], cwdRoot: "/repo" }],
	},
};

function writePolicy(dir, config, mode = 0o600) {
	const file = join(dir, "scheduler-policy.json");
	writeFileSync(file, `${JSON.stringify(config)}\n`, { mode: 0o600 });
	chmodSync(file, mode);
	return file;
}

// POSIX-only guard: the ownership/mode checks are skipped on Windows where
// Node does not expose a meaningful uid/gid and never applies UNIX bits.
const POSIX =
	typeof process.getuid === "function" && process.platform !== "win32";

test("loadPolicyFromFile denies by default when the file is absent", () => {
	const policy = loadPolicyFromFile(
		join("/nonexistent", "scheduler-policy.json"),
	);
	const decision = policy.decide({
		task: { action: "shell", command: { executable: "npm", argv: ["test"] } },
		cwd: "/repo",
	});
	assert.equal(decision.allowed, false);
	assert.match(decision.reason || "", /default|disabled|opt-in/i);
});

test("loadPolicyFromFile authorizes an allowlisted structured command", () => {
	withTempDirSync((dir) => {
		const file = writePolicy(dir, {
			execution: {
				enabled: true,
				allow: [{ executable: "npm", argvPrefix: ["test"], cwdRoot: dir }],
			},
		});
		const policy = loadPolicyFromFile(file);
		const decision = policy.decide({
			task: { action: "shell", command: { executable: "npm", argv: ["test"] } },
			cwd: dir,
		});
		assert.equal(decision.allowed, true);
		assert.equal(decision.shell, false);
	});
});

// Synchronous temp-dir wrapper for the few pure/sync tests above.
function withTempDirSync(fn) {
	const dir = mkdtempSync(join(tmpdir(), "pi-scheduler-policy-sync-"));
	try {
		return fn(dir);
	} finally {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
}

test("loadPolicyFromFile re-reads on every call: an edit takes effect immediately", () => {
	withTempDirSync((dir) => {
		const file = writePolicy(dir, {
			execution: {
				enabled: true,
				allow: [{ executable: "npm", argvPrefix: ["test"], cwdRoot: dir }],
			},
		});

		// Initially allowed.
		let decision = loadPolicyFromFile(file).decide({
			task: { action: "shell", command: { executable: "npm", argv: ["test"] } },
			cwd: dir,
		});
		assert.equal(decision.allowed, true);

		// Revoke by disabling execution and rewriting the file on disk. The NEXT
		// call must reflect the change WITHOUT any cache invalidation call —
		// proving the policy is loaded fresh per decision.
		writeFileSync(
			file,
			`${JSON.stringify({ execution: { enabled: false } })}\n`,
			{
				mode: 0o600,
			},
		);
		chmodSync(file, 0o600);

		decision = loadPolicyFromFile(file).decide({
			task: { action: "shell", command: { executable: "npm", argv: ["test"] } },
			cwd: dir,
		});
		assert.equal(
			decision.allowed,
			false,
			"a policy edit must be honored on the next decision",
		);
	});
});

test("loadPolicyFromFile re-reads on every call: removing the file reverts to deny-by-default", () => {
	withTempDirSync((dir) => {
		const file = writePolicy(dir, {
			execution: {
				enabled: true,
				allow: [{ executable: "npm", argvPrefix: ["test"], cwdRoot: dir }],
			},
		});
		assert.equal(
			loadPolicyFromFile(file).decide({
				task: {
					action: "shell",
					command: { executable: "npm", argv: ["test"] },
				},
				cwd: dir,
			}).allowed,
			true,
		);
		rmSync(file, { force: true });
		const decision = loadPolicyFromFile(file).decide({
			task: { action: "shell", command: { executable: "npm", argv: ["test"] } },
			cwd: dir,
		});
		assert.equal(decision.allowed, false);
		assert.match(decision.reason || "", /default|disabled|opt-in/i);
	});
});

test("a group-writable policy file is rejected and fails closed", () => {
	if (!POSIX) {
		// Skipped on Windows: mode bits are not meaningful there.
		return;
	}
	withTempDirSync((dir) => {
		const file = writePolicy(dir, ALLOW_CONFIG, 0o660); // group-writable
		const decision = loadPolicyFromFile(file).decide({
			task: { action: "shell", command: { executable: "npm", argv: ["test"] } },
			cwd: "/repo",
		});
		assert.equal(decision.allowed, false);
		assert.match(decision.reason || "", /group|world|writable|chmod|600/i);
	});
});

test("a world-writable policy file is rejected and fails closed", () => {
	if (!POSIX) return;
	withTempDirSync((dir) => {
		const file = writePolicy(dir, ALLOW_CONFIG, 0o606); // other-writable (world write)
		const decision = loadPolicyFromFile(file).decide({
			task: { action: "shell", command: { executable: "npm", argv: ["test"] } },
			cwd: "/repo",
		});
		assert.equal(decision.allowed, false);
		assert.match(decision.reason || "", /group|world|writable|chmod|600/i);
	});
});

test("a symlinked policy file is rejected as non-regular and fails closed", () => {
	withTempDirSync((dir) => {
		const real = writePolicy(dir, ALLOW_CONFIG);
		const link = join(dir, "scheduler-policy-link.json");
		try {
			symlinkSync(real, link);
		} catch (error) {
			// Some CI sandboxes forbid creating symlinks; skip if unavailable.
			if (error && /EPERM|EACCES/.test(error.code || "")) return;
			throw error;
		}
		const decision = loadPolicyFromFile(link).decide({
			task: { action: "shell", command: { executable: "npm", argv: ["test"] } },
			cwd: "/repo",
		});
		assert.equal(decision.allowed, false);
		assert.match(decision.reason || "", /regular|symlink|file/i);
	});
});

test("pre-open validation rejects policy symlinks without relying on O_NOFOLLOW", () => {
	withTempDirSync((dir) => {
		const real = writePolicy(dir, ALLOW_CONFIG);
		const link = join(dir, "scheduler-policy-link.json");
		try {
			symlinkSync(real, link);
		} catch (error) {
			if (error && /EPERM|EACCES/.test(error.code || "")) return;
			throw error;
		}

		const validation = validatePolicyPathBeforeOpen(link);
		assert.equal(validation.ok, false);
		assert.equal(validation.absent, undefined);
		assert.match(validation.reason || "", /symlink/i);
	});
});

test("descriptor is closed when fstat fails after a successful open", () => {
	const closed = [];
	const fakeFs = {
		openSync: () => 0,
		fstatSync: () => {
			throw new Error("fstat failed");
		},
		closeSync: (fd) => closed.push(fd),
	};

	assert.throws(
		() => openAndStatPolicyFile(fakeFs, "policy.json", 0),
		/fstat failed/,
	);
	assert.deepEqual(closed, [0], "fd 0 must be closed on fstat failure");
});

test("opened policy identity must match both pre-open and post-open path identities", () => {
	const original = { dev: 1, ino: 10 };
	const replacement = { dev: 1, ino: 20 };

	assert.equal(
		validateOpenedPolicyIdentity("policy.json", original, original, original)
			.ok,
		true,
	);
	assert.equal(
		validateOpenedPolicyIdentity(
			"policy.json",
			original,
			replacement,
			replacement,
		).ok,
		false,
		"replacement between pre-check and open must fail closed",
	);
	assert.equal(
		validateOpenedPolicyIdentity("policy.json", original, original, replacement)
			.ok,
		false,
		"ineffective no-follow with a swapped-back path must fail closed",
	);
});

test("a malformed JSON policy file fails closed rather than widening", () => {
	withTempDirSync((dir) => {
		const file = join(dir, "scheduler-policy.json");
		writeFileSync(file, "{ not valid json ]", { mode: 0o600 });
		const decision = loadPolicyFromFile(file).decide({
			task: { action: "shell", command: { executable: "npm", argv: ["test"] } },
			cwd: "/repo",
		});
		assert.equal(decision.allowed, false);
		assert.match(decision.reason || "", /malformed|json|disabled/i);
	});
});

test("loadPolicyConfig reports absent for a missing path and ok:true for a valid one", () => {
	withTempDirSync((dir) => {
		const missing = join(dir, "absent.json");
		const absent = loadPolicyConfig(missing);
		assert.equal(absent.ok, false);
		assert.equal(absent.absent, true);

		const file = writePolicy(dir, ALLOW_CONFIG);
		const loaded = loadPolicyConfig(file);
		assert.equal(loaded.ok, true);
		assert.equal(loaded.config.execution.enabled, true);
	});
});

test("loadPolicyConfig reports a non-ok reason (not absent) for a group-writable file on POSIX", () => {
	if (!POSIX) return;
	withTempDirSync((dir) => {
		const file = writePolicy(dir, ALLOW_CONFIG, 0o660);
		const loaded = loadPolicyConfig(file);
		assert.equal(loaded.ok, false);
		assert.equal(loaded.absent, undefined);
		assert.match(loaded.reason || "", /group|world|writable|chmod|600/i);
	});
});

test("a policy file in a group-writable parent directory fails closed on POSIX", () => {
	if (!POSIX) return;
	withTempDirSync((parent) => {
		// Create a dedicated subdirectory and make the PARENT group-writable so
		// an attacker could swap the policy file into it.
		const { mkdirSync, chmodSync } = require("node:fs");
		const policyDir = join(parent, "policies");
		mkdirSync(policyDir, { mode: 0o700 });
		const file = join(policyDir, "scheduler-policy.json");
		writeFileSync(file, `${JSON.stringify(ALLOW_CONFIG)}\n`, { mode: 0o600 });
		chmodSync(policyDir, 0o770); // group-writable parent
		try {
			const loaded = loadPolicyConfig(file);
			assert.equal(loaded.ok, false);
			assert.match(
				loaded.reason || "",
				/directory|group|world|writable|chmod|700/i,
			);
		} finally {
			chmodSync(policyDir, 0o700);
		}
	});
});

test("a policy file read via the no-follow fd is the file that was validated (symlink rejected)", () => {
	// O_NOFOLLOW (where available) prevents opening a symlink at all; on
	// platforms without it, the fstat non-regular / ELOOP path rejects it. Either
	// way the symlinked policy must fail closed.
	withTempDirSync((dir) => {
		const real = writePolicy(dir, ALLOW_CONFIG);
		const link = join(dir, "scheduler-policy-link.json");
		try {
			symlinkSync(real, link);
		} catch (error) {
			if (error && /EPERM|EACCES/.test(error.code || "")) return;
			throw error;
		}
		const loaded = loadPolicyConfig(link);
		assert.equal(loaded.ok, false);
		assert.match(loaded.reason || "", /symlink|regular|file/i);
	});
});
