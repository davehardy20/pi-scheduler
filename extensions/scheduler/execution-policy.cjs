// Deny-by-default execution policy for scheduled process execution.
//
// Direct process execution is DISABLED unless a caller explicitly opts in via
// `execution.enabled = true` AND supplies a non-empty `execution.allow`
// allowlist. Legacy shell command STRINGS are never interpreted: they fail
// closed with an actionable reason. Only structured `{ executable, argv }`
// commands are even considered, and only when both the executable and the
// argv prefix match an allowlist entry whose `cwdRoot` contains the resolved
// working directory.
//
// When a command is allowed, the policy returns the literal argv to run
// directly (no shell). Shell metacharacters present inside an argv element
// are treated as opaque data and passed through verbatim — they are never
// tokenized or interpreted.

"use strict";

const nodePath = require("node:path");
const fs = require("node:fs");
const { constants, realpathSync, statSync } = fs;

// Fail-closed error reported when the policy file is missing or unreadable.
// Distinct from an absent file (which is the normal deny-by-default state):
// a path that exists but cannot be safely validated fails closed with a
// reason that names the file so the user can fix it.
//
// POSIX file ownership/mode validation is enforced ONLY on POSIX platforms.
// On Windows, fs.stat does not expose a meaningful uid/gid/mode, so mode
// validation is skipped (Node never applies UNIX permission bits there
// anyway). The policy still fails closed on a missing/unreadable file.

// Actions that the policy considers safe to migrate and never marks for
// auto-execution. These never reach `decide` because they are not process
// executions.
const SAFE_DISPLAY_ACTIONS = new Set(["notify", "prompt", "message"]);

const DENY_DEFAULT_REASON =
	"Scheduled process execution is disabled by default; set execution.enabled=true and add an execution.allow entry to opt in.";

/**
 * Coerce a value to a trimmed string. Returns "" for null/undefined.
 */
function asString(value) {
	if (value === null || value === undefined) return "";
	return String(value);
}

/**
 * Normalize a path. POSIX-style forward slashes are resolved so that a config
 * authored on one platform behaves consistently. Relative paths are resolved
 * against process.cwd() so containment checks are well defined.
 *
 * Returns the normalized absolute path WITHOUT resolving symlinks (symlink
 * resolution requires filesystem access, which the policy deliberately does
 * not perform — it is a pure validation layer over caller-supplied data).
 */
function normalizePath(value) {
	const raw = asString(value).trim();
	if (!raw) return "";
	const forward = raw.replace(/\\/g, "/");
	const resolved = nodePath.posix.normalize(forward);
	// Make absolute for deterministic prefix/containment comparison.
	const absolute = nodePath.posix.isAbsolute(resolved)
		? resolved
		: nodePath.posix.resolve("/", resolved);
	// Collapse any remaining "/../" or "/./" segments after resolution.
	return nodePath.posix.normalize(absolute);
}

/**
 * Resolve a path to its REALPATH and require it to be an existing DIRECTORY.
 * Returns the resolved absolute real path string, or null when the path is
 * missing, not a directory, or cannot be resolved. Used for cwd containment
 * so a symlink that escapes the root is rejected (no symlink-escape bypass)
 * and a relative/nonexistent/non-directory root fails closed.
 *
 * realpath is used (not a string normalize) so containment is enforced against
 * the TRUE filesystem location, defeating traversal/symlink tricks.
 */
function resolveDirectory(value) {
	const raw = asString(value).trim();
	if (!raw) return null;
	try {
		const resolved = realpathSync(raw);
		const stat = statSync(resolved);
		if (!stat.isDirectory()) return null;
		return resolved;
	} catch {
		return null;
	}
}

/**
 * Select native path semantics for the target platform. The optional platform
 * argument keeps Windows behavior testable from non-Windows development hosts.
 */
function pathApiForPlatform(platform = process.platform) {
	return platform === "win32" ? nodePath.win32 : nodePath.posix;
}

/** Return whether a configured root is absolute for the target platform. */
function isAbsoluteConfiguredPath(value, platform = process.platform) {
	const raw = asString(value).trim();
	if (!raw) return false;
	return pathApiForPlatform(platform).isAbsolute(raw);
}

/**
 * Both inputs must already be normalized absolute paths. Native relative-path
 * semantics preserve Windows drive/UNC handling and enforce directory boundaries
 * on every platform.
 */
function isPathWithin(child, parent, platform = process.platform) {
	if (!child || !parent) return false;
	const pathApi = pathApiForPlatform(platform);
	const relative = pathApi.relative(parent, child);
	return (
		relative === "" ||
		(relative !== ".." &&
			!relative.startsWith(`..${pathApi.sep}`) &&
			!pathApi.isAbsolute(relative))
	);
}

/**
 * Validate that a value is a non-empty string usable as an executable name.
 * Rejects anything that is not a primitive string, is empty, or contains
 * path/null/control characters that could smuggle a shell escape.
 */
function isValidExecutable(value) {
	if (typeof value !== "string") return false;
	const trimmed = value.trim();
	if (!trimmed) return false;
	// Reject NUL, DEL, and other C0 control characters outright.
	for (const character of trimmed) {
		const codePoint = character.codePointAt(0);
		if (codePoint <= 0x1f || codePoint === 0x7f) return false;
	}
	return true;
}

/**
 * Validate an argv array: must be a dense array of non-empty strings free of
 * NUL/control characters used to break out of a single argument.
 */
function isValidArgv(value) {
	if (!Array.isArray(value)) return false;
	return value.every((element) => {
		if (typeof element !== "string") return false;
		// NUL bytes would truncate an argument at the OS layer.
		if (element.includes("\u0000")) return false;
		return true;
	});
}

/**
 * Validate an allowlist entry shape. Returns a normalized entry or null when
 * malformed (the policy fails closed on any malformed entry by dropping it
 * from consideration; if that leaves no entries, execution is denied).
 */
function normalizeAllowEntry(entry, platform = process.platform) {
	if (!entry || typeof entry !== "object") return null;

	if (!isValidExecutable(entry.executable)) return null;
	const executable = asString(entry.executable).trim();

	const argvPrefix = Array.isArray(entry.argvPrefix)
		? entry.argvPrefix
		: entry.argvPrefix === undefined || entry.argvPrefix === null
			? []
			: null;
	if (argvPrefix === null) return null;
	if (!isValidArgv(argvPrefix)) return null;

	// cwdRoot is required: without it there is no containment boundary to
	// enforce, so the entry cannot safely authorize any execution. It must be
	// an ABSOLUTE path string; existence, directory-ness, and realpath
	// containment are validated at decision time (fail closed) so a revoked
	// or moved root is honored immediately.
	const cwdRootRaw = asString(entry.cwdRoot).trim();
	if (!isAbsoluteConfiguredPath(cwdRootRaw, platform)) return null;

	return {
		executable,
		argvPrefix: argvPrefix.slice(),
		cwdRoot: cwdRootRaw,
	};
}

/**
 * Validate the top-level policy configuration. Returns a normalized shape or
 * null when the config is absent/malformed (absent config means deny-by-
 * default; malformed config also fails closed).
 */
function normalizeConfig(config) {
	if (config === undefined || config === null) {
		return { enabled: false, allow: [] };
	}
	if (typeof config !== "object") return null;

	const execution = config.execution;
	if (execution === undefined || execution === null) {
		return { enabled: false, allow: [] };
	}
	if (typeof execution !== "object") return null;

	const enabled = execution.enabled === true;
	const rawAllow = Array.isArray(execution.allow) ? execution.allow : [];
	const allow = [];
	for (const entry of rawAllow) {
		const normalized = normalizeAllowEntry(entry);
		// Malformed allow entries are dropped rather than throwing, so a
		// single bad entry cannot be exploited as a fallback. If every entry
		// is malformed, `allow` is empty and execution is denied.
		if (normalized) allow.push(normalized);
	}
	return { enabled, allow };
}

/**
 * Build the structured-command descriptor from a task. Returns null when the
 * command is a legacy string (which must fail closed) or otherwise malformed.
 *
 * Return shapes:
 *   { kind: "string" }                       -> legacy command string
 *   { kind: "structured", executable, argv } -> structured command
 */
function readCommand(task) {
	if (!task || typeof task !== "object") return { kind: "invalid" };
	const command = task.command;
	if (command === undefined || command === null) return { kind: "missing" };
	if (typeof command === "string") return { kind: "string" };
	if (typeof command !== "object") return { kind: "invalid" };

	// Only the structured { executable, argv } shape is accepted.
	const executable = command.executable;
	const argv = command.argv;
	if (!isValidExecutable(executable)) return { kind: "invalid" };
	if (argv !== undefined && argv !== null && !isValidArgv(argv)) {
		return { kind: "invalid" };
	}
	const argvArray = Array.isArray(argv) ? argv.slice() : [];
	return {
		kind: "structured",
		executable: asString(executable).trim(),
		argv: argvArray,
	};
}

function deny(reason) {
	return { allowed: false, reason };
}

/**
 * Create an execution policy bound to the given configuration.
 *
 * @param {object} [config]
 * @param {object} [config.execution]
 * @param {boolean} [config.execution.enabled] - explicit opt-in required.
 * @param {Array<{executable: string, argvPrefix?: string[], cwdRoot: string}>} [config.execution.allow]
 * @returns {{ decide: (ctx: { task: object, cwd?: string }) => object }}
 */
function createExecutionPolicy(config) {
	const normalized = normalizeConfig(config);
	if (normalized === null) {
		// Malformed config fails closed with a stable deny result.
		return {
			decide() {
				return deny(
					"Scheduled process execution policy received a malformed configuration; execution is disabled. Provide a valid execution policy with execution.enabled and execution.allow entries.",
				);
			},
		};
	}

	const { enabled, allow } = normalized;

	function decide(ctx) {
		if (!enabled) {
			return deny(DENY_DEFAULT_REASON);
		}
		if (allow.length === 0) {
			return deny(
				"Scheduled process execution is enabled but no execution.allow entries are configured; add at least one allow entry with executable, argvPrefix, and cwdRoot.",
			);
		}

		const task = ctx && typeof ctx === "object" ? ctx.task : undefined;
		if (!task || typeof task !== "object") {
			return deny("Scheduled task is malformed; execution is disabled.");
		}

		const action = asString(task.action).trim().toLowerCase();
		// Only "shell" tasks route through process execution. Other actions
		// are not process executions and are not authorized here.
		if (action && action !== "shell") {
			return deny(
				`Action "${action || "unknown"}" is not a process execution and is not authorized by the execution policy.`,
			);
		}

		const command = readCommand(task);

		if (command.kind === "missing") {
			return deny(
				"Scheduled shell task has no command; execution is disabled. Provide a structured command { executable, argv }.",
			);
		}

		if (command.kind === "string") {
			// Legacy command strings are NEVER interpreted. They fail closed
			// with an actionable reason so users re-create them with argv.
			return deny(
				"Legacy command strings are not executed; re-create this task with a structured command { executable, argv } and add a matching execution.allow entry.",
			);
		}

		if (command.kind === "invalid") {
			return deny(
				"Scheduled shell command is malformed; execution is disabled. Provide a structured command { executable, argv } with non-empty executable and array argv of strings.",
			);
		}

		// command.kind === "structured"
		const { executable, argv } = command;

		// Validate the firing cwd against every candidate allow entry. An
		// entry authorizes the command only when executable matches exactly,
		// argv starts with the entry's argvPrefix, AND the REALPATH-resolved cwd
		// is contained beneath the REALPATH-resolved cwdRoot. Both roots and the
		// firing cwd must be absolute, existing DIRECTORIES; a symlink that
		// escapes the root, or a nonexistent/non-directory/relative path, fails
		// closed.
		const requestedCwd = ctx && ctx.cwd !== undefined ? ctx.cwd : process.cwd();
		const realCwd = resolveDirectory(requestedCwd);
		if (realCwd === null) {
			return deny(
				`Scheduled shell task cwd "${requestedCwd}" is not an existing directory; execution is disabled. Run beneath an allowlisted cwdRoot.`,
			);
		}

		let cwdRejected = false;
		let rootRejected = false;
		for (const entry of allow) {
			if (entry.executable !== executable) continue;
			if (!startsWithPrefix(argv, entry.argvPrefix)) continue;
			// Resolve the entry's cwdRoot fresh each decision (no cache) so a
			// moved/removed root is honored immediately.
			const realRoot = resolveDirectory(entry.cwdRoot);
			if (realRoot === null) {
				rootRejected = true;
				continue;
			}
			if (!isPathWithin(realCwd, realRoot)) {
				// This entry would match except for cwd. Remember so we can
				// surface a cwd-specific reason if no entry ultimately matches.
				cwdRejected = true;
				continue;
			}
			// Authorized: return literal argv for direct (no-shell) execution.
			// Carry the verified real cwd so the runtime executes there (never
			// the caller-supplied path that might traverse symlinks).
			return {
				allowed: true,
				shell: false,
				executable,
				argv: [executable, ...argv],
				cwd: realCwd,
			};
		}

		if (rootRejected) {
			return deny(
				"A configured cwdRoot is not an existing directory; execution is disabled. Ensure cwdRoot entries point to existing absolute directories.",
			);
		}
		if (cwdRejected) {
			return deny(
				`cwd "${requestedCwd}" is outside all configured cwdRoot values for this command; execution is disabled. Run beneath an allowlisted cwdRoot.`,
			);
		}

		return deny(
			`Executable "${executable}" with argv prefix [${argv.join(", ")}] is not permitted by any execution.allow entry; add a matching allow entry to authorize it.`,
		);
	}

	return { decide };
}

/**
 * True when `argv` begins with every element of `prefix`, in order.
 */
function startsWithPrefix(argv, prefix) {
	if (!Array.isArray(prefix) || prefix.length === 0) return true;
	if (!Array.isArray(argv) || argv.length < prefix.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (argv[i] !== prefix[i]) return false;
	}
	return true;
}

/**
 * Migrate a persisted task into the current safety model.
 *
 * Safe display tasks (notify, prompt, message) are preserved verbatim and are
 * NEVER marked for auto-execution — `autoExecute` is left undefined so callers
 * default to non-executing behavior.
 *
 * Legacy persisted shell tasks that carry a bare command STRING remain
 * displayable (the original command text is preserved) but are flagged
 * `autoExecute: false` so they never run automatically until the user
 * re-creates them with structured argv. Structured shell commands are passed
 * through untouched (the execution policy gates them at fire time).
 *
 * @param {object} task
 * @returns {object}
 */
function migrateTask(task) {
	const migrated = task && typeof task === "object" ? { ...task } : {};
	const action = asString(migrated.action).trim().toLowerCase();

	if (SAFE_DISPLAY_ACTIONS.has(action)) {
		// Safe tasks never auto-execute. Do not set autoExecute at all so the
		// absence is itself the signal (callers treat undefined as false).
		return migrated;
	}

	if (action === "shell") {
		const command = migrated.command;
		if (typeof command === "string") {
			// Preserve the original text for display/history, but never run it.
			migrated.autoExecute = false;
		}
		// Structured commands are validated by the execution policy at fire
		// time; migration does not need to second-guess them here.
		return migrated;
	}

	// Unknown/missing action: leave as-is without enabling execution.
	return migrated;
}

// `process.getuid`/`getgid` are absent on Windows. Guard so the POSIX checks
// below are skipped there; Node never applies UNIX permission bits on
// Windows regardless, so failing to check mode there is not a security gap.
const HAS_POSIX_IDS = typeof process.getuid === "function";
const IS_WIN32 = process.platform === "win32";

// Any mode bit set in this mask is a write privilege granted to someone other
// than the file owner. A policy file writable by group or world is an
// unacceptable privilege boundary for an allowlist that authorizes direct
// process execution, so such files are rejected and the policy fails closed.
const NON_OWNER_WRITE_MASK = 0o022;

/**
 * Reject a policy path that is itself a symbolic link before opening it.
 * O_NOFOLLOW is unavailable or ineffective on some platforms (notably
 * Windows), so this explicit lstat check preserves the fail-closed contract.
 * The opened descriptor remains the authority for file type/content checks.
 */
function validatePolicyPathBeforeOpen(policyPath) {
	try {
		const pathStat = fs.lstatSync(policyPath);
		if (pathStat.isSymbolicLink()) {
			return {
				ok: false,
				reason: `Scheduled execution policy file is a symlink (${policyPath}). Execution is disabled; replace it with a regular file.`,
			};
		}
		return { ok: true, stat: pathStat };
	} catch (error) {
		if (
			error &&
			(error.code === "ENOENT" || error.code === "MODULE_NOT_FOUND")
		) {
			return { ok: false, absent: true };
		}
		return {
			ok: false,
			reason: `Scheduled execution policy file cannot be safely inspected (${policyPath}): ${error?.code ? error.code : error?.message ? error.message : "unknown error"}. Execution is disabled.`,
		};
	}
}

function policyFileIdentityMatches(pathStat, descriptorStat) {
	return (
		Number.isFinite(pathStat?.dev) &&
		Number.isFinite(pathStat?.ino) &&
		Number.isFinite(descriptorStat?.dev) &&
		Number.isFinite(descriptorStat?.ino) &&
		pathStat.dev === descriptorStat.dev &&
		pathStat.ino === descriptorStat.ino
	);
}

function validateOpenedPolicyIdentity(
	policyPath,
	preOpenStat,
	postOpenStat,
	descriptorStat,
) {
	if (
		policyFileIdentityMatches(preOpenStat, descriptorStat) &&
		policyFileIdentityMatches(postOpenStat, descriptorStat)
	) {
		return { ok: true };
	}
	return {
		ok: false,
		reason: `Scheduled execution policy file changed while being opened (${policyPath}). Execution is disabled; retry with a stable regular file.`,
	};
}

/** Open and fstat a policy file, closing any acquired fd if fstat fails. */
function openAndStatPolicyFile(fsSync, policyPath, flags) {
	let fd;
	try {
		fd = fsSync.openSync(policyPath, flags);
		return { fd, stat: fsSync.fstatSync(fd) };
	} catch (error) {
		if (fd !== undefined) {
			try {
				fsSync.closeSync(fd);
			} catch {
				// best-effort close while preserving the original open/fstat error
			}
		}
		throw error;
	}
}

/**
 * Result of attempting to load and validate the policy file.
 *
 *   { ok: true,  config }            -> file present, validated, parsed
 *   { ok: false, absent: true }      -> file does not exist (deny-by-default)
 *   { ok: false, reason }            -> file present but unsafe/malformed
 *
 * This NEVER throws: callers treat any non-ok result as deny-by-default so a
 * tampered or malformed policy file can never widen execution. A safe default
 * is the only outcome of an unreadable/untrusted policy.
 *
 * TOCTOU-safe loading (lead review medium fix 5): the file is opened ONCE with
 * O_NOFOLLOW where available, but flag presence is never trusted as proof of
 * enforcement. Every platform binds both pre-open and post-open lstat identity
 * to the OPEN FILE DESCRIPTOR, rejecting symlinks and replacements before the
 * content is trusted. We fstat and read JSON from that same fd, so the bytes
 * validated are the bytes parsed. On POSIX the policy PARENT DIRECTORY must
 * also be owned by the current user and not be group/world-writable, so an
 * attacker cannot replace the policy file by writing into its directory.
 */
function loadPolicyConfig(filePath) {
	const policyPath = asString(filePath);
	if (!policyPath) return { ok: false, absent: true };

	const preOpenPath = validatePolicyPathBeforeOpen(policyPath);
	if (!preOpenPath.ok) return preOpenPath;

	// Open the policy file once, without following symlinks where the platform
	// supports O_NOFOLLOW. Using the fd for both fstat and read closes the
	// lstat/read TOCTOU window: the file we validate is the file we parse.
	const fsSync = fs;
	const noFollowFlag =
		typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const flags = constants.O_RDONLY | noFollowFlag;
	let fd;
	let stat;
	try {
		({ fd, stat } = openAndStatPolicyFile(fsSync, policyPath, flags));
	} catch (error) {
		if (
			error &&
			(error.code === "ENOENT" || error.code === "MODULE_NOT_FOUND")
		) {
			return { ok: false, absent: true };
		}
		// ELOOP is raised on platforms with O_NOFOLLOW when the path is a symlink.
		if (error && error.code === "ELOOP") {
			return {
				ok: false,
				reason: `Scheduled execution policy file is a symlink (${policyPath}). Execution is disabled; replace it with a regular file.`,
			};
		}
		return {
			ok: false,
			reason: `Scheduled execution policy file is not readable (${policyPath}): ${error?.code ? error.code : error?.message ? error.message : "unknown error"}. Execution is disabled.`,
		};
	}

	try {
		// Always repeat lstat after opening and bind BOTH path observations to the
		// opened descriptor. O_NOFOLLOW may exist but be ineffective on a platform;
		// identity binding, not flag presence, is the fail-closed authority.
		const postOpenPath = validatePolicyPathBeforeOpen(policyPath);
		if (!postOpenPath.ok) return postOpenPath;
		const identity = validateOpenedPolicyIdentity(
			policyPath,
			preOpenPath.stat,
			postOpenPath.stat,
			stat,
		);
		if (!identity.ok) return identity;

		// The policy file MUST be a regular file. fstat on the no-follow fd
		// rejects symlinks (ELOOP above or non-regular here) as well as sockets,
		// devices, pipes, and directories.
		if (!stat.isFile()) {
			return {
				ok: false,
				reason: `Scheduled execution policy file is not a regular file (${policyPath}). Execution is disabled; remove or replace it with a regular file.`,
			};
		}

		// POSIX ownership and mode validation of the OPEN FD. Skipped on Windows
		// where Node does not expose a meaningful uid/gid and never applies UNIX
		// permission bits.
		if (!IS_WIN32 && HAS_POSIX_IDS) {
			const ownerUid = process.getuid();

			if (typeof stat.uid === "number" && stat.uid !== ownerUid) {
				return {
					ok: false,
					reason: `Scheduled execution policy file is not owned by the current user (uid ${stat.uid}, expected ${ownerUid}) at ${policyPath}. Execution is disabled; run 'chown "$USER" "${policyPath}"' and 'chmod 600 "${policyPath}"'.`,
				};
			}

			const mode = stat.mode & 0o777;
			if ((mode & NON_OWNER_WRITE_MASK) !== 0) {
				return {
					ok: false,
					reason: `Scheduled execution policy file is group- or world-writable (mode 0o${mode.toString(8).padStart(3, "0")}) at ${policyPath}. Execution is disabled; run 'chmod 600 "${policyPath}"'.`,
				};
			}

			// Validate the PARENT directory too: it must be owned by the current
			// user and not group/world-writable, so an attacker cannot replace the
			// policy file by writing into its directory (rename/unlink swap).
			const parentDirResult = validatePolicyParentDir(policyPath, ownerUid);
			if (parentDirResult !== null) {
				return { ok: false, reason: parentDirResult };
			}
		}

		// Read and parse JSON FROM THE OPEN FD. A syntax error fails closed.
		let config;
		try {
			const raw = fsSync.readFileSync(fd, "utf8");
			config = JSON.parse(raw);
		} catch (error) {
			return {
				ok: false,
				reason: `Scheduled execution policy file is malformed JSON (${policyPath}): ${error?.message ? error.message : "parse error"}. Execution is disabled.`,
			};
		}

		return { ok: true, config };
	} finally {
		try {
			fsSync.closeSync(fd);
		} catch {
			// best-effort close
		}
	}
}

/**
 * Validate the policy file's PARENT directory on POSIX: it must be owned by
 * the current user and not group/world-writable. Without this, an attacker
 * with write access to the directory could swap the policy file (rename/unlink)
 * between validation and use. Returns null when OK, or a denial reason string.
 */
function validatePolicyParentDir(policyPath, ownerUid) {
	const parent = nodePath.dirname(policyPath);
	let dirStat;
	try {
		// stat (not lstat) is acceptable here: we are checking the real parent
		// directory the kernel resolves for the policy path. A symlinked parent
		// that points outside the user-owned state tree would still need to be
		// user-owned and non-writable-by-group/world to pass.
		dirStat = statSync(parent);
	} catch (error) {
		return `Scheduled execution policy directory is not accessible (${parent}): ${error?.code ? error.code : "error"}. Execution is disabled.`;
	}
	if (!dirStat.isDirectory()) {
		return `Scheduled execution policy path parent (${parent}) is not a directory. Execution is disabled.`;
	}
	if (typeof dirStat.uid === "number" && dirStat.uid !== ownerUid) {
		return `Scheduled execution policy directory (${parent}) is not owned by the current user (uid ${dirStat.uid}, expected ${ownerUid}). Execution is disabled.`;
	}
	const dirMode = dirStat.mode & 0o777;
	if ((dirMode & NON_OWNER_WRITE_MASK) !== 0) {
		return `Scheduled execution policy directory (${parent}) is group- or world-writable (mode 0o${dirMode.toString(8).padStart(3, "0")}). Execution is disabled; run 'chmod 700 "${parent}"'.`;
	}
	return null;
}

/**
 * Load the execution policy FRESH from disk for a single scheduling/firing
 * decision. Nothing is cached: every call re-reads, re-validates ownership/
 * mode, and re-parses the file so a policy revocation or edit takes effect at
 * the next decision without a restart.
 *
 * A missing file is the normal deny-by-default state (returns a deny policy
 * with the standard absent-config reason). A file that exists but is
 * unsafe (non-regular, not user-owned, group/world-writable, or malformed)
 * fails closed with an actionable reason that names the file.
 *
 * @param {string} filePath
 * @returns {{ decide: (ctx: { task: object, cwd?: string }) => object }}
 */
function loadPolicyFromFile(filePath) {
	const loaded = loadPolicyConfig(filePath);
	if (!loaded.ok) {
		if (loaded.absent) return createExecutionPolicy();
		const reason = loaded.reason;
		return {
			decide() {
				return deny(reason);
			},
		};
	}
	return createExecutionPolicy(loaded.config);
}

module.exports = {
	createExecutionPolicy,
	loadPolicyFromFile,
	loadPolicyConfig,
	migrateTask,
	// Exported for targeted unit testing / reuse.
	normalizePath,
	isAbsoluteConfiguredPath,
	isPathWithin,
	isValidExecutable,
	isValidArgv,
	normalizeConfig,
	normalizeAllowEntry,
	openAndStatPolicyFile,
	validateOpenedPolicyIdentity,
	validatePolicyPathBeforeOpen,
};
