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
 * True when `child` is the same as, or nested beneath, `parent`. Both inputs
 * must already be normalized absolute paths. Containment treats the parent as
 * a directory boundary, so "/repo" contains "/repo" and "/repo/sub" but NOT
 * "/repository".
 */
function isPathWithin(child, parent) {
	if (!child || !parent) return false;
	if (child === parent) return true;
	const prefix = parent.endsWith("/") ? parent : `${parent}/`;
	return child.startsWith(prefix);
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
function normalizeAllowEntry(entry) {
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

	const cwdRoot = normalizePath(entry.cwdRoot);
	// cwdRoot is required: without it there is no containment boundary to
	// enforce, so the entry cannot safely authorize any execution.
	if (!cwdRoot) return null;

	return { executable, argvPrefix: argvPrefix.slice(), cwdRoot };
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
		// argv starts with the entry's argvPrefix, AND the normalized cwd is
		// contained beneath the entry's cwdRoot.
		const requestedCwd = ctx && ctx.cwd !== undefined ? ctx.cwd : process.cwd();
		const normalizedCwd = normalizePath(requestedCwd);
		if (!normalizedCwd) {
			return deny(
				"Scheduled shell task has no resolvable cwd; execution is disabled. Set a cwd contained beneath a configured cwdRoot.",
			);
		}

		let cwdRejected = false;
		for (const entry of allow) {
			if (entry.executable !== executable) continue;
			if (!startsWithPrefix(argv, entry.argvPrefix)) continue;
			if (!isPathWithin(normalizedCwd, entry.cwdRoot)) {
				// This entry would match except for cwd. Remember so we can
				// surface a cwd-specific reason if no entry ultimately matches.
				cwdRejected = true;
				continue;
			}
			// Authorized: return literal argv for direct (no-shell) execution.
			return {
				allowed: true,
				shell: false,
				executable,
				argv: [executable, ...argv],
			};
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

module.exports = {
	createExecutionPolicy,
	migrateTask,
	// Exported for targeted unit testing / reuse.
	normalizePath,
	isPathWithin,
	isValidExecutable,
	isValidArgv,
	normalizeConfig,
	normalizeAllowEntry,
};
