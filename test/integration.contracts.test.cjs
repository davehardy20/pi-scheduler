// Integration contracts for the scheduler safety wiring landed in step 4 of
// plan pl-9e04 (Seeds child pi-scheduler-6392).
//
// These tests exercise the COMPOSED behavior that index.ts depends on:
//   * the task store (claim/complete lifecycle + locked transactions),
//   * the deny-by-default execution policy (scheduling-time rejection,
//     firing-time revalidation, structured-only direct execution, no shell),
//   * and the locale-deterministic date formatter.
//
// They deliberately avoid booting a full Pi process. Instead they drive the
// same .cjs modules index.ts wires together, so a regression in any of them
// surfaces here as a real assertion failure rather than a runtime-only error.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const ROOT = join(__dirname, "..", "extensions", "scheduler");
const { createTaskStore } = require(join(ROOT, "task-store.cjs"));
const { createExecutionPolicy, migrateTask } = require(
	join(ROOT, "execution-policy.cjs"),
);
const core = require(join(ROOT, "scheduler-core.cjs"));

async function withTempDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), "pi-scheduler-int-"));
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// The policy now resolves cwdRoot/cwd via realpath and requires them to be
// existing directories, so policy tests use real temp dirs.
function withTempDirSync(fn) {
	const dir = mkdtempSync(join(tmpdir(), "pi-scheduler-policy-int-"));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function dueTask(overrides = {}) {
	const due = new Date(Date.now() - 1000).toISOString();
	return {
		id: "int_due",
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

// ---------------------------------------------------------------------------
// Scheduling-time rejection: a shell task whose command is a legacy STRING or
// an unallowlisted structured command must be refused BEFORE it is persisted.
// index.ts calls policy.decide() inside createAndSchedule().
// ---------------------------------------------------------------------------

test("scheduling-time rejection: legacy shell command string is refused by the policy", () => {
	// Even an explicitly enabled policy must reject a legacy command string.
	const policy = createExecutionPolicy({
		execution: {
			enabled: true,
			allow: [{ executable: "npm", argvPrefix: ["test"], cwdRoot: "/repo" }],
		},
	});
	const decision = policy.decide({
		task: { action: "shell", command: "npm test && echo done" },
		cwd: "/repo",
	});
	assert.equal(decision.allowed, false);
	assert.match(decision.reason || "", /legacy|command string|argv|structured/i);
});

test("scheduling-time rejection: structured command not in the allowlist is refused", () => {
	const policy = createExecutionPolicy({
		execution: {
			enabled: true,
			allow: [{ executable: "npm", argvPrefix: ["test"], cwdRoot: "/repo" }],
		},
	});
	const decision = policy.decide({
		task: {
			action: "shell",
			command: { executable: "npm", argv: ["publish"] },
		},
		cwd: "/repo",
	});
	assert.equal(decision.allowed, false);
});

test("scheduling-time rejection: deny-by-default when no policy file is configured", () => {
	const policy = createExecutionPolicy(); // absent config => deny by default
	const decision = policy.decide({
		task: { action: "shell", command: { executable: "npm", argv: ["test"] } },
		cwd: "/repo",
	});
	assert.equal(decision.allowed, false);
	assert.match(decision.reason || "", /default|disabled|opt-in/i);
});

test("malformed policy config fails closed", () => {
	const policy = createExecutionPolicy({ execution: "not-an-object" });
	const decision = policy.decide({
		task: { action: "shell", command: { executable: "npm", argv: ["test"] } },
		cwd: "/repo",
	});
	assert.equal(decision.allowed, false);
	assert.match(decision.reason || "", /malformed|disabled/i);
});

// ---------------------------------------------------------------------------
// Firing-time revalidation: the same policy.decide() is invoked again
// immediately before execution. A task whose command was tampered with after
// scheduling (or whose allowlist changed) must be refused at fire time.
// ---------------------------------------------------------------------------

test("firing-time revalidation refuses a structured command whose argv drifted", () => {
	withTempDirSync((repo) => {
		const policy = createExecutionPolicy({
			execution: {
				enabled: true,
				allow: [{ executable: "npm", argvPrefix: ["test"], cwdRoot: repo }],
			},
		});
		// At scheduling the command was allowed...
		assert.equal(
			policy.decide({
				task: {
					action: "shell",
					command: { executable: "npm", argv: ["test"] },
				},
				cwd: repo,
			}).allowed,
			true,
		);
		// ...but at fire time the persisted command was changed to a disallowed argv.
		const redecide = policy.decide({
			task: {
				action: "shell",
				command: { executable: "npm", argv: ["publish"] },
			},
			cwd: repo,
		});
		assert.equal(redecide.allowed, false);
	});
});

test("firing-time revalidation refuses when cwd has moved outside the allowlist root", () => {
	withTempDirSync((repo) => {
		withTempDirSync((elsewhere) => {
			const policy = createExecutionPolicy({
				execution: {
					enabled: true,
					allow: [{ executable: "npm", argvPrefix: ["test"], cwdRoot: repo }],
				},
			});
			const decision = policy.decide({
				task: {
					action: "shell",
					command: { executable: "npm", argv: ["test"] },
				},
				cwd: elsewhere,
			});
			assert.equal(decision.allowed, false);
			assert.match(decision.reason || "", /cwd|root|outside/i);
		});
	});
});

// ---------------------------------------------------------------------------
// No bash invocation: when a structured command is allowed, the policy returns
// argv to run DIRECTLY (shell:false). index.ts passes decision.argv (minus the
// leading executable) to pi.exec() — never "bash" with ["-lc", string].
// ---------------------------------------------------------------------------

test("allowed structured command runs directly without a shell", () => {
	withTempDirSync((repo) => {
		const policy = createExecutionPolicy({
			execution: {
				enabled: true,
				allow: [{ executable: "npm", argvPrefix: ["test"], cwdRoot: repo }],
			},
		});
		const decision = policy.decide({
			task: {
				action: "shell",
				command: { executable: "npm", argv: ["test", "--silent"] },
			},
			cwd: repo,
		});
		assert.equal(decision.allowed, true);
		assert.equal(decision.shell, false, "execution must never invoke a shell");
		assert.equal(decision.executable, "npm");
		// The returned argv is the literal program + args, suitable for direct exec.
		assert.deepEqual(decision.argv, ["npm", "test", "--silent"]);
		// Sanity: the executable is never "bash" and no element is "-lc".
		assert.notEqual(decision.executable, "bash");
		assert.ok(!decision.argv.includes("-lc"), "must never pass -lc to a shell");
	});
});

test("legacy command string migration preserves text but never auto-executes", () => {
	const migrated = migrateTask({
		id: "legacy",
		action: "shell",
		command: "echo legacy && rm -rf /",
	});
	assert.equal(migrated.command, "echo legacy && rm -rf /");
	assert.equal(migrated.autoExecute, false);
});

// ---------------------------------------------------------------------------
// Store use: the full claim -> execute -> complete lifecycle runs through the
// locked task store. Only the claim owner can complete; another runner cannot.
// Expired leases recover so a crashed owner does not strand a task.
// ---------------------------------------------------------------------------

test("store lifecycle: due task is claimed once and completed only by the claim owner", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		writeFileSync(
			file,
			`${JSON.stringify({ version: 2, updatedAt: "now", tasks: [dueTask()] })}\n`,
			{ mode: 0o600 },
		);
		const store = createTaskStore({ filePath: file });

		const claim = await store.claimDueTask({
			runnerId: "owner",
			now: new Date(),
			leaseMs: 60000,
		});
		assert.equal(claim.claimed, true);
		assert.equal(claim.task.id, "int_due");
		assert.equal(claim.runnerId, "owner");
		assert.ok(claim.claimToken);

		// A second runner cannot steal a live claim.
		const second = await store.claimDueTask({
			runnerId: "intruder",
			now: new Date(),
			leaseMs: 60000,
		});
		assert.equal(second.claimed, false);

		// Only the matching runnerId + claimToken may complete.
		await assert.rejects(
			store.completeClaimedTask({
				taskId: "int_due",
				runnerId: "intruder",
				claimToken: claim.claimToken,
			}),
			/runner|identity|mismatch/i,
		);
		const completed = await store.completeClaimedTask({
			taskId: "int_due",
			runnerId: "owner",
			claimToken: claim.claimToken,
			result: { ok: true },
			now: new Date(),
		});
		assert.equal(completed.status, "fired");
		assert.equal(completed.runCount, 1);
	});
});

test("store lifecycle: a specific due task can be claimed by id (timer-targeted claim)", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		const due = new Date(Date.now() - 1000).toISOString();
		const future = new Date(Date.now() + 60000).toISOString();
		writeFileSync(
			file,
			`${JSON.stringify({
				version: 2,
				updatedAt: "now",
				tasks: [
					dueTask({ id: "target", nextRun: due, dueAt: due }),
					dueTask({ id: "not_yet", nextRun: future, dueAt: future }),
				],
			})}\n`,
			{ mode: 0o600 },
		);
		const store = createTaskStore({ filePath: file });

		// Claiming by the specific id of the fired timer must not accidentally
		// grab the not-yet-due task.
		const claim = await store.claimDueTask({
			runnerId: "owner",
			taskId: "target",
			now: new Date(),
			leaseMs: 60000,
		});
		assert.equal(claim.claimed, true);
		assert.equal(claim.task.id, "target");
	});
});

test("store lifecycle: expired lease is recovered by a new runner", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		const due = new Date(Date.now() - 1000).toISOString();
		writeFileSync(
			file,
			`${JSON.stringify({ version: 2, updatedAt: "now", tasks: [dueTask({ nextRun: due, dueAt: due })] })}\n`,
			{ mode: 0o600 },
		);
		const store = createTaskStore({ filePath: file });

		const live = await store.claimDueTask({
			runnerId: "owner",
			now: new Date(),
			leaseMs: 60000,
		});
		assert.equal(live.claimed, true);

		// Simulate the owner crashing mid-run: the lease expires, but it was
		// never completed. A later runner must recover it.
		const later = new Date(Date.now() + 120_000);
		const recovered = await store.claimDueTask({
			runnerId: "recoverer",
			now: later,
			leaseMs: 60000,
		});
		assert.equal(recovered.claimed, true);
		assert.equal(recovered.runnerId, "recoverer");
	});
});

test("store lifecycle: a locked transaction serializes concurrent appends", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		writeFileSync(
			file,
			`${JSON.stringify({ version: 2, updatedAt: "now", tasks: [] })}\n`,
			{
				mode: 0o600,
			},
		);
		const store = createTaskStore({ filePath: file });

		const append = (id) =>
			store.transaction((tasks) => {
				tasks.push(dueTask({ id }));
			});

		await Promise.all([append("a"), append("b"), append("c"), append("d")]);

		const data = JSON.parse(readFileSync(file, "utf8"));
		assert.equal(data.tasks.length, 4, "every concurrent append must survive");
	});
});

test("store lifecycle: safe actions (notify/prompt/message) never route through the policy", () => {
	// The policy only authorizes process executions; safe display actions must
	// be denied by the policy (so they are never auto-executed) while still
	// being delivered directly by index.ts without policy involvement.
	const policy = createExecutionPolicy({
		execution: {
			enabled: true,
			allow: [{ executable: "npm", argvPrefix: ["test"], cwdRoot: "/repo" }],
		},
	});
	for (const action of ["notify", "prompt", "message"]) {
		const decision = policy.decide({
			task: { action, message: "x" },
			cwd: "/repo",
		});
		assert.equal(
			decision.allowed,
			false,
			`${action} must not be authorized as a process execution`,
		);
	}
});

// ---------------------------------------------------------------------------
// Locale determinism: the beyond-tomorrow date branch renders a stable
// month-then-day form regardless of host locale (same-day/tomorrow unchanged).
// ---------------------------------------------------------------------------

test("locale determinism: beyond-tomorrow renders month-then-day independent of locale", () => {
	const now = new Date("2026-07-05T12:00:00Z");
	const later = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);
	const rendered = core.formatAbsoluteTime(later.toISOString(), now);
	assert.match(rendered, /^on [A-Z][a-z]{2} \d+ at \d{2}:\d{2}$/);
});

test("locale determinism: same-day and tomorrow branches are preserved", () => {
	const now = new Date("2026-07-05T12:00:00Z");
	const sameDay = core.formatAbsoluteTime(
		new Date(now.getTime() + 3 * 3600_000).toISOString(),
		now,
	);
	assert.match(sameDay, /^at \d{2}:\d{2}$/);
	const tomorrow = core.formatAbsoluteTime(
		new Date(now.getTime() + 24 * 3600_000).toISOString(),
		now,
	);
	assert.match(tomorrow, /^tomorrow at \d{2}:\d{2}$/);
});

// ---------------------------------------------------------------------------
// Persistence safety: a structured command's raw stdout/stderr and full command
// text are NOT persisted by index.ts (only exit metadata). This contract pins
// that the store itself does not add output; callers control what is stored.
// ---------------------------------------------------------------------------

test("persistence safety: completion stores only provided result metadata, not implicit output", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		const due = new Date(Date.now() - 1000).toISOString();
		writeFileSync(
			file,
			`${JSON.stringify({ version: 2, updatedAt: "now", tasks: [dueTask({ id: "shell_task", action: "shell", nextRun: due, dueAt: due })] })}\n`,
			{ mode: 0o600 },
		);
		const store = createTaskStore({ filePath: file });

		const claim = await store.claimDueTask({
			runnerId: "owner",
			now: new Date(),
			leaseMs: 60000,
		});
		// index.ts passes only metadata (no stdout/stderr/full command text).
		const result = {
			ok: true,
			executable: "npm",
			cwd: "/repo",
			code: 0,
			killed: false,
		};
		const completed = await store.completeClaimedTask({
			taskId: "shell_task",
			runnerId: "owner",
			claimToken: claim.claimToken,
			result,
			now: new Date(),
		});
		assert.deepEqual(completed.result, result);
		assert.equal(
			completed.result.stdout,
			undefined,
			"stdout must not be persisted",
		);
		assert.equal(
			completed.result.stderr,
			undefined,
			"stderr must not be persisted",
		);

		// The on-disk task carries no leaked output either.
		const onDisk = JSON.parse(readFileSync(file, "utf8"));
		const diskTask = onDisk.tasks.find((t) => t.id === "shell_task");
		assert.equal(diskTask.result.stdout, undefined);
	});
});

// ---------------------------------------------------------------------------
// Lifecycle recovery (Seeds child pi-scheduler-6392, lead-review fixes):
//   * an out-of-scope once task claimed by a runner that should NOT execute it
//     is abandoned (restored to pending, runCount unchanged) — NOT marked
//     fired. It remains reclaimable by an eligible runner.
//   * the execution policy is loaded FRESH from disk on every decision, so a
//     policy revocation between scheduling and firing is honored at fire time
//     without any cache invalidation call.
// ---------------------------------------------------------------------------

test("lifecycle recovery: abandoning an out-of-scope once task keeps it pending and reclaimable", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "tasks.json");
		const due = new Date(Date.now() - 1000).toISOString();
		writeFileSync(
			file,
			`${JSON.stringify({
				version: 2,
				updatedAt: "now",
				tasks: [
					dueTask({
						id: "out_of_scope",
						type: "once",
						nextRun: due,
						dueAt: due,
					}),
				],
			})}\n`,
			{ mode: 0o600 },
		);
		const store = createTaskStore({ filePath: file });

		// A runner that should NOT execute the task claims it (e.g. a different
		// session scoped task grabbed by a sweep). The integration layer would
		// then call abandonClaimedTask, NOT completeClaimedTask.
		const claim = await store.claimDueTask({
			runnerId: "wrong_session",
			now: new Date(),
			leaseMs: 60000,
		});
		assert.equal(claim.claimed, true);

		const abandoned = await store.abandonClaimedTask({
			taskId: "out_of_scope",
			runnerId: "wrong_session",
			claimToken: claim.claimToken,
			now: new Date(),
		});

		// Contract: the once task is PENDING (not fired), runCount is 0, and a
		// later eligible runner can reclaim it and actually fire it.
		assert.equal(
			abandoned.status,
			"pending",
			"abandon must not mark a once task fired",
		);
		assert.equal(abandoned.runCount, 0, "abandon must not bump runCount");

		const reclaim = await store.claimDueTask({
			runnerId: "right_session",
			now: new Date(),
			leaseMs: 60000,
		});
		assert.equal(reclaim.claimed, true, "abandoned task must be reclaimable");
		const completed = await store.completeClaimedTask({
			taskId: "out_of_scope",
			runnerId: "right_session",
			claimToken: reclaim.claimToken,
			result: { ok: true },
			now: new Date(),
		});
		assert.equal(completed.status, "fired");
		assert.equal(
			completed.runCount,
			1,
			"only the real completion counts as a run",
		);
	});
});

test("lifecycle recovery: policy revocation between scheduling and firing is honored (fresh load)", async () => {
	await withTempDir(async (dir) => {
		const policyFile = join(dir, "scheduler-policy.json");
		writeFileSync(
			policyFile,
			`${JSON.stringify({
				execution: {
					enabled: true,
					allow: [{ executable: "npm", argvPrefix: ["test"], cwdRoot: dir }],
				},
			})}\n`,
			{ mode: 0o600 },
		);

		const task = {
			action: "shell",
			command: { executable: "npm", argv: ["test"] },
		};

		// At scheduling time the command is authorized.
		assert.equal(
			createExecutionPolicy(
				JSON.parse(readFileSync(policyFile, "utf8")),
			).decide({
				task,
				cwd: dir,
			}).allowed,
			true,
		);

		// Revoke the policy on disk between scheduling and firing. The next
		// fresh load must honor the revocation with NO cache invalidation call.
		writeFileSync(
			policyFile,
			`${JSON.stringify({ execution: { enabled: false } })}\n`,
			{ mode: 0o600 },
		);

		const { loadPolicyFromFile } = require(join(ROOT, "execution-policy.cjs"));
		const decision = loadPolicyFromFile(policyFile).decide({
			task,
			cwd: dir,
		});
		assert.equal(
			decision.allowed,
			false,
			"a policy revocation must be honored by a fresh load at fire time",
		);
		assert.match(decision.reason || "", /default|disabled|opt-in/i);
	});
});

test("lifecycle recovery: a group-writable policy file fails closed at fire time", async () => {
	if (typeof process.getuid !== "function" || process.platform === "win32")
		return;
	await withTempDir(async (dir) => {
		const policyFile = join(dir, "scheduler-policy.json");
		writeFileSync(
			policyFile,
			`${JSON.stringify({
				execution: {
					enabled: true,
					allow: [
						{ executable: "npm", argvPrefix: ["test"], cwdRoot: "/repo" },
					],
				},
			})}\n`,
			{ mode: 0o600 },
		);
		// Tamper: make it group-writable. The fresh load at fire time must reject it.
		const { chmodSync } = require("node:fs");
		chmodSync(policyFile, 0o660);

		const { loadPolicyFromFile } = require(join(ROOT, "execution-policy.cjs"));
		const decision = loadPolicyFromFile(policyFile).decide({
			task: { action: "shell", command: { executable: "npm", argv: ["test"] } },
			cwd: "/repo",
		});
		assert.equal(decision.allowed, false);
		assert.match(decision.reason || "", /group|world|writable|chmod|600/i);
	});
});

test("schedule_task prompt nudges agents to arm a bounded GitHub PR watch", () => {
	// Behavioral guard: the schedule_task tool prompt must tell agents to watch
	// a PR's CI, review comments, and mergeability until the PR is merged/closed,
	// so a PR opened in a session is never left unmonitored (scheduler-rules
	// Rule 1). Pin the key signal strings so this nudge cannot be silently
	// weakened or removed.
	const source = readFileSync(join(ROOT, "index.ts"), "utf8");
	const tool = source.slice(
		source.indexOf('name: "schedule_task"'),
		source.indexOf('name: "list_scheduled_tasks"'),
	);
	assert.match(tool, /promptGuidelines/);
	assert.match(tool, /gh_safe pr_create/);
	assert.match(tool, /gh_safe pr_checks/);
	assert.match(tool, /gh_safe pr_review_view/);
	assert.match(tool, /gh_safe pr_view/);
	assert.match(tool, /maxRuns/);
	assert.match(tool, /scheduler-rules\.md/);
});

test("index.ts wires the fire-time settle through runClaimedExecution into the engine", () => {
	// After the scheduling-engine extraction, index.ts no longer contains
	// fireTask; it injects runtime.runClaimedExecution as the engine's settle
	// helper. The full settle behavior (success-after-shutdown, execute
	// rejection after shutdown, success-completion-throws, reload-throws) is
	// covered behaviorally in scheduler-runtime.contracts.test.cjs, and the
	// engine's own orchestration invariants in scheduler-engine.contracts.test.cjs.
	const source = readFileSync(join(ROOT, "index.ts"), "utf8");
	assert.ok(
		/run:\s*runtime\.runClaimedExecution/.test(source),
		"index.ts must inject runtime.runClaimedExecution as the engine settle helper",
	);
});

test("engine refreshes the active view after an older execution settles", () => {
	const source = readFileSync(join(ROOT, "scheduler-engine.cjs"), "utf8");
	assert.match(source, /shouldReload: \(\) => !isShutdown/);
	assert.match(
		source,
		/reload: async \(\) => \{[\s\S]*?await reloadMirror\(\);[\s\S]*?generation !== sessionGeneration && !isShutdown\)[\s\S]*?rescheduleAll\(\);[\s\S]*?\},/,
	);
});

test("shell completion avoids stale-session messages after async execution", () => {
	// executeTask (still in index.ts) gates completion reporting on isLive().
	// The engine passes a LIVE-UPDATING isLive closure that re-checks its own
	// generation/shutdown at completion time, so a stale session that replaced
	// (or shut down after) the in-flight execution never receives the message.
	const indexSrc = readFileSync(join(ROOT, "index.ts"), "utf8");
	const engineSrc = readFileSync(join(ROOT, "scheduler-engine.cjs"), "utf8");
	assert.match(
		indexSrc,
		/if \(isLive\(\)\) \{[\s\S]*?recordMessage\([\s\S]*?sendAgentPrompt\([\s\S]*?\n\t\t\t\}/,
	);
	assert.match(
		engineSrc,
		/execute\([\s\S]*?\(\) => generation === sessionGeneration && !isShutdown/,
	);
});

test("lease recovery refreshes persisted state before rearming an empty sweep", () => {
	const source = readFileSync(join(ROOT, "scheduler-engine.cjs"), "utf8");
	const emptyBranch = source.match(
		/if \(expired\.length === 0\) \{([\s\S]*?)\n\t\t\t\}/,
	);
	assert.ok(emptyBranch, "empty lease-recovery branch must exist");
	assert.match(emptyBranch[1], /await reloadMirror\(\)/);
	assert.match(emptyBranch[1], /rescheduleAll\(\)/);
	assert.match(
		emptyBranch[1],
		/await reloadMirror\(\);[\s\S]*if \(generation === sessionGeneration && !isShutdown\)[\s\S]*rescheduleAll\(\)/,
		"shutdown/generation must be re-checked after reload before rescheduling",
	);
	assert.doesNotMatch(emptyBranch[1], /armLeaseRecovery\(\)/);
});

test("all lease recovery paths re-check liveness after async reloads", () => {
	const source = readFileSync(join(ROOT, "scheduler-engine.cjs"), "utf8");
	const recovery = source.slice(
		source.indexOf("async function recoverExpiredLeases"),
		source.indexOf("async function safeReleaseClaim"),
	);
	assert.match(
		recovery,
		/for \(const task of expired\)[\s\S]*?refreshAfterMutation\(generation\)/,
	);
	assert.match(
		recovery,
		/catch \{[\s\S]*?await reloadMirror\(\);[\s\S]*?if \(generation === sessionGeneration && !isShutdown\)[\s\S]*?armLeaseRecovery\(\)/,
	);
});

test("stale claim abandonment refreshes the active successor session", () => {
	const source = readFileSync(join(ROOT, "scheduler-engine.cjs"), "utf8");
	// Both abandonment sites in fireTask — the shutdown-during-claim branch and
	// the scope-out branch — must release the claim and then re-arm the now
	// pending task for the live (possibly successor) session via
	// refreshAfterMutation, matching the original refreshActiveSessionAfterMutation
	// successor refresh. Otherwise a claim in-flight across shutdown + rebind is
	// stranded until lease recovery rather than being re-armed immediately.
	const fireTask = source.slice(
		source.indexOf("async function fireTask"),
		source.indexOf("function bind(deps)"),
	);
	// Shutdown-during-claim: release the stray claim, then refresh the
	// (possibly successor) session view so the released task is re-armed.
	assert.match(
		fireTask,
		/if \(generation !== sessionGeneration \|\| isShutdown\) \{[\s\S]*?await safeReleaseClaim\(claimed\.task, claimed\.claimToken\);[\s\S]*?await refreshAfterMutation\(generation\);/,
		"shutdown-during-claim must refresh the active successor session",
	);
	// Scope-out: release the out-of-scope claim, then refresh the (possibly
	// successor) session view so the released task is re-armed when eligible.
	assert.match(
		fireTask,
		/if \(bound && !bound\.isInScope\(task\)\) \{[\s\S]*?await safeReleaseClaim\(task, claimed\.claimToken\);[\s\S]*?await refreshAfterMutation\(generation\);/,
		"scope-out must refresh the active successor session",
	);
});

test("fireTask re-checks liveness after claim reloads", () => {
	const source = readFileSync(join(ROOT, "scheduler-engine.cjs"), "utf8");
	// In the engine, fireTask is defined AFTER its helpers (safeReleaseClaim,
	// scheduleClaimRetry), so slice through the next top-level function (bind).
	const fireTask = source.slice(
		source.indexOf("async function fireTask"),
		source.indexOf("function bind(deps)"),
	);
	const claimPreparation = fireTask.slice(
		0,
		fireTask.indexOf("const task = claimed.task"),
	);
	assert.equal(claimPreparation.match(/await reloadMirror\(\)/g)?.length, 2);
	assert.equal(
		claimPreparation.match(
			/await reloadMirror\(\);[\s\S]*?catch \{[\s\S]*?\}[\s\S]*?if \(generation !== sessionGeneration \|\| isShutdown\) return;[\s\S]*?rescheduleAll\(\)/g,
		)?.length,
		2,
	);
});

test("claim reload failures use bounded delayed retries", () => {
	const source = readFileSync(join(ROOT, "scheduler-engine.cjs"), "utf8");
	assert.match(
		source,
		/function scheduleClaimRetry[\s\S]*?runtime\.claimFalseRearmDelay\(attempt\)/,
	);
	const claimFalse = source.slice(
		source.indexOf("if (!claimed?.claimed)"),
		source.indexOf("const task = claimed.task"),
	);
	assert.match(
		claimFalse,
		/if \(reloaded\) rescheduleAll\(\);\s*else scheduleClaimRetry\(taskId, generation, rearmAttempt\)/,
	);
});
