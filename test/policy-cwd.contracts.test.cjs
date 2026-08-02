// Contracts for realpath-based cwd containment in the execution policy.
//
// High finding (3): policy cwd containment previously used STRING-only path
// normalization (normalizePath) with no filesystem resolution. Required
// behavior:
//   * cwdRoot must be an ABSOLUTE path to an EXISTING DIRECTORY; a relative,
//     nonexistent, or non-directory root is rejected (fail closed).
//   * both the configured cwdRoot and the firing cwd are resolved with
//     realpath at decision time, so a symlink that escapes the root is
//     rejected (no symlink-escape bypass).
//   * the VERIFIED real cwd is what execution must use (the runtime passes
//     decision.cwd to pi.exec).
//   * a firing cwd that does not exist or is not a directory is rejected.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	mkdtempSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const POLICY_PATH = join(
	__dirname,
	"..",
	"extensions",
	"scheduler",
	"execution-policy.cjs",
);
const {
	createExecutionPolicy,
	isAbsoluteConfiguredPath,
	isPathWithin,
	normalizeAllowEntry,
} = require(POLICY_PATH);

function withTempDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), "pi-scheduler-cwd-"));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const COMMAND = { executable: "npm", argv: ["test"] };
const TASK = { action: "shell", command: COMMAND };

test("an absolute existing-directory cwdRoot authorizes a contained cwd", () => {
	withTempDir((root) => {
		const sub = join(root, "sub");
		mkdirSync(sub);
		const policy = createExecutionPolicy({
			execution: {
				enabled: true,
				allow: [{ executable: "npm", argvPrefix: ["test"], cwdRoot: root }],
			},
		});
		const decision = policy.decide({ task: TASK, cwd: sub });
		assert.equal(decision.allowed, true);
		assert.equal(decision.shell, false);
		// The verified real cwd is returned so the runtime executes there.
		assert.ok(decision.cwd, "decision must carry the verified real cwd");
	});
});

test("a relative cwdRoot is rejected (must be absolute existing directory)", () => {
	withTempDir((root) => {
		const policy = createExecutionPolicy({
			execution: {
				enabled: true,
				allow: [
					{ executable: "npm", argvPrefix: ["test"], cwdRoot: "relative/root" },
				],
			},
		});
		const decision = policy.decide({ task: TASK, cwd: root });
		assert.equal(decision.allowed, false);
		assert.match(decision.reason || "", /cwdRoot|absolute|directory|exist/i);
	});
});

test("a nonexistent cwdRoot is rejected", () => {
	withTempDir((root) => {
		const policy = createExecutionPolicy({
			execution: {
				enabled: true,
				allow: [
					{
						executable: "npm",
						argvPrefix: ["test"],
						cwdRoot: join(root, "nope"),
					},
				],
			},
		});
		const decision = policy.decide({ task: TASK, cwd: root });
		assert.equal(decision.allowed, false);
		assert.match(decision.reason || "", /cwdRoot|exist|directory/i);
	});
});

test("a cwdRoot that is a file (not a directory) is rejected", () => {
	withTempDir((root) => {
		const file = join(root, "afile");
		writeFileSync(file, "x");
		const policy = createExecutionPolicy({
			execution: {
				enabled: true,
				allow: [{ executable: "npm", argvPrefix: ["test"], cwdRoot: file }],
			},
		});
		const decision = policy.decide({ task: TASK, cwd: root });
		assert.equal(decision.allowed, false);
		assert.match(decision.reason || "", /cwdRoot|directory/i);
	});
});

test("a symlink that escapes the cwdRoot is rejected", () => {
	withTempDir((root) => {
		// Outside target that the symlink will point to.
		const outside = mkdtempSync(join(tmpdir(), "pi-scheduler-escape-"));
		try {
			const sub = join(root, "sub");
			mkdirSync(sub);
			const link = join(sub, "escape");
			try {
				symlinkSync(outside, link);
			} catch (error) {
				if (/EPERM|EACCES/.test(error.code || "")) return;
				throw error;
			}
			const policy = createExecutionPolicy({
				execution: {
					enabled: true,
					allow: [{ executable: "npm", argvPrefix: ["test"], cwdRoot: root }],
				},
			});
			// The firing cwd is a symlink that resolves OUTSIDE the root.
			const decision = policy.decide({ task: TASK, cwd: link });
			assert.equal(decision.allowed, false);
			assert.match(decision.reason || "", /cwd|root|outside|symlink|escape/i);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

test("a nonexistent firing cwd is rejected", () => {
	withTempDir((root) => {
		const policy = createExecutionPolicy({
			execution: {
				enabled: true,
				allow: [{ executable: "npm", argvPrefix: ["test"], cwdRoot: root }],
			},
		});
		const decision = policy.decide({
			task: TASK,
			cwd: join(root, "does-not-exist"),
		});
		assert.equal(decision.allowed, false);
		assert.match(decision.reason || "", /cwd|exist|directory/i);
	});
});

test("a firing cwd that is a file is rejected", () => {
	withTempDir((root) => {
		const file = join(root, "afile");
		writeFileSync(file, "x");
		const policy = createExecutionPolicy({
			execution: {
				enabled: true,
				allow: [{ executable: "npm", argvPrefix: ["test"], cwdRoot: root }],
			},
		});
		const decision = policy.decide({ task: TASK, cwd: file });
		assert.equal(decision.allowed, false);
		assert.match(decision.reason || "", /cwd|directory/i);
	});
});

test("traversal in the firing cwd is resolved away and rejected when it escapes the root", () => {
	withTempDir((root) => {
		const policy = createExecutionPolicy({
			execution: {
				enabled: true,
				allow: [{ executable: "npm", argvPrefix: ["test"], cwdRoot: root }],
			},
		});
		// /tmp/.../root/../<sibling> resolves outside root.
		const decision = policy.decide({
			task: TASK,
			cwd: join(root, ".."),
		});
		assert.equal(decision.allowed, false);
		assert.match(decision.reason || "", /cwd|root|outside/i);
	});
});

test("the verified real cwd is returned on an allow", () => {
	withTempDir((root) => {
		const policy = createExecutionPolicy({
			execution: {
				enabled: true,
				allow: [{ executable: "npm", argvPrefix: ["test"], cwdRoot: root }],
			},
		});
		const decision = policy.decide({ task: TASK, cwd: root });
		assert.equal(decision.allowed, true);
		// decision.cwd is the realpath-resolved absolute directory.
		assert.equal(decision.cwd, require("node:fs").realpathSync(root));
	});
});

test("Windows drive roots are absolute and use native containment semantics", () => {
	const root = "C:\\repo";
	const nested = "C:\\repo\\subdir";

	assert.equal(isAbsoluteConfiguredPath(root, "win32"), true);
	assert.equal(isPathWithin(nested, root, "win32"), true);
	assert.equal(isPathWithin("C:\\repository", root, "win32"), false);

	assert.deepEqual(
		normalizeAllowEntry(
			{ executable: "npm", argvPrefix: ["test"], cwdRoot: root },
			"win32",
		),
		{ executable: "npm", argvPrefix: ["test"], cwdRoot: root },
	);
});
