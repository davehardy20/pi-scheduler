# Pi Scheduler

**Scheduled actions for Pi agents: reminders, self-waking prompts, allowlisted structured shell commands, and command-output follow-ups.**

Pi Scheduler is a [Pi](https://github.com/earendil-works/pi) extension that lets an agent schedule future work from inside the conversation. It focuses on **scheduled actions**, not just prompts: the agent can wake itself later, run allowlisted structured commands directly (no shell), pass stdout/stderr to the in-memory follow-up prompt, and decide what to do next.

## Why?

Coding agents often need to wait:

- A GitLab/GitHub pipeline is still running.
- A deployment needs a few minutes to roll out.
- A long build or test command should be checked later.
- You want a reminder or a recurring project check.

Without scheduling, the agent has to stop and hope you come back. With Pi Scheduler, it can schedule follow-up work such as:

> “Run `glab pipeline view` every 5 minutes, wake me only on failure, and stop after 10 checks.”

## Features

- **Self-waking prompts** — schedule a future prompt that wakes the agent in the current Pi session.
- **Direct, deny-by-default shell scheduling** — run allowlisted structured commands later or repeatedly, validated at scheduling and firing time, never through a shell.
- **Command-output follow-ups** — feed stdout/stderr back to the agent with success/failure-specific instructions.
- **Recurring schedules** — `once`, `interval`, and `cron` schedules for all action types.
- **Bounded polling** — `maxRuns` disables recurring tasks after a fixed number of executions.
- **Task lifecycle management** — enable, disable, update, remove, cleanup, list.
- **Cross-process safe persistence** — locked transactions, atomic claims with leases, and automatic crash recovery.
- **Scopes** — bind tasks to a session, cwd/project, or all sessions.
- **Compact widget** — shows the next few scheduled actions below the editor.
- **Persistent state** — scheduled tasks are stored in `~/.pi/agent/state/scheduler/tasks.json`.

## Install

Install from npm:

```bash
pi install npm:@jl1990/pi-scheduler
```

Or install directly from GitHub:

```bash
pi install git:git@github.com:jl1990/pi-scheduler.git
```

Then restart Pi, or run:

```text
/reload
```

## Agent tools

Pi Scheduler registers these tools for the agent:

- `schedule_task` — schedule a future or recurring action.
- `list_scheduled_tasks` — list active or historical tasks.
- `cancel_scheduled_task` — cancel a task by ID or prefix.
- `manage_scheduled_task` — enable, disable, remove, update, or cleanup tasks.

### Scheduled action types

| Action | What it does | Best for |
| --- | --- | --- |
| `shell` | Runs an allowlisted structured command directly (no shell); exit metadata is persisted, stdout/stderr are passed to the in-memory follow-up prompt only and are NOT persisted | CI polling, tests, status commands |
| `prompt` | Injects a user prompt and wakes the agent | Agentic follow-ups |
| `notify` | Shows a reminder/notification | Human reminders |
| `message` | Injects a scheduled custom message | Lightweight status/context messages |

### Scheduling shell tasks

Shell tasks are **structured**: the agent provides a command object
`{ executable, argv }`, never a command string. The `/schedule` slash command
and `/remind` are for `notify`, `prompt`, and `message` actions only. **The
`/schedule shell <when> :: <command-string>` slash syntax is rejected** — a
legacy command string is never interpreted through a shell, so it always fails
closed.

To schedule a shell task, use the **`schedule_task`** tool with a structured
command:

```json
{
  "action": "shell",
  "type": "once",
  "schedule": "2m",
  "command": { "executable": "npm", "argv": ["test"] },
  "cwd": "/repo",
  "wakeOn": "always",
  "followUpPrompt": "Review this test output."
}
```

A `schedule_task` shell task is validated against the user-owned execution
policy at scheduling time and revalidated immediately before firing; only
structured commands matching the policy allowlist run, directly (no shell).

### Schedule types

| Type | Example | Meaning |
| --- | --- | --- |
| `once` | `5m`, `tomorrow at 9am`, ISO datetime | Run one time |
| `interval` | `5m`, `1h`, `30s` | Run repeatedly after each interval |
| `cron` | `0 */5 * * * *` | Run on a cron schedule via `croner` |

Cron expressions use `croner`; 6-field expressions with seconds are recommended:

```text
0 */5 * * * *   every 5 minutes
0 0 * * * *     hourly
0 0 9 * * 1-5   weekdays at 9am
```

## Example: bounded GitLab pipeline polling

Schedule a direct, allowlisted command every 5 minutes, wake the agent only if
it fails, and stop after 10 checks. Requires a matching entry in
`scheduler-policy.json` (see [Scheduled shell execution is deny-by-default](#scheduled-shell-execution-is-deny-by-default)):

```json
{
  "action": "shell",
  "type": "interval",
  "schedule": "5m",
  "name": "pipeline-123",
  "command": { "executable": "glab", "argv": ["pipeline", "view", "123", "--repo", "jl1990/example"] },
  "cwd": "/repo",
  "wakeOn": "failure",
  "failurePrompt": "The scheduled pipeline check failed or returned a non-zero status. Inspect the pipeline/jobs/logs and propose or apply fixes.",
  "maxRuns": 10,
  "scope": "cwd"
}
```

## Example: recurring agent prompt

```json
{
  "action": "prompt",
  "type": "interval",
  "schedule": "10m",
  "prompt": "Check whether the deployment has finished. If it failed, inspect logs. If it is still running, continue monitoring.",
  "maxRuns": 6
}
```

## Example: one-shot command with output review

```json
{
  "action": "shell",
  "type": "once",
  "schedule": "2m",
  "command": { "executable": "npm", "argv": ["test"] },
  "cwd": "/repo",
  "wakeOn": "always",
  "followUpPrompt": "Review this test output. If tests failed, fix the issue. If they passed, summarize the result."
}
```

## Slash commands

```text
/schedule [notify|prompt|shell|message] [once|interval|cron|every] <schedule> :: <payload>
/remind <when> <message>
/schedules
/schedules all
/schedule-cancel <id-or-prefix>
/schedule-enable <id-or-prefix>
/schedule-disable <id-or-prefix>
/schedule-remove <id-or-prefix>
/schedule-cleanup
/schedule-widget [on|off]
```

Examples:

```text
/remind 5m stretch
/schedule prompt 3m :: Check the GitLab pipeline and schedule another check if still running.
/schedule message 5m :: build started
/schedules
/schedules all
/schedule-disable task_abc123
/schedule-cleanup
```

> Shell tasks are structured and use the `schedule_task` tool, not `/schedule shell`.
> See [Scheduling shell tasks](#scheduling-shell-tasks) above. The
> `/schedule shell <when> :: <command-string>` syntax is rejected (legacy
> command strings are never interpreted through a shell).

## Time formats

One-shot schedules support examples like:

```text
5m
+5m
in 10 minutes
1h30m
2 days
tomorrow at 9am
14:30
2026-07-06T10:00:00
```

Interval schedules use durations like:

```text
30s
5m
1h
2d
```

## Scopes

`scope` controls where a task is visible and allowed to fire:

| Scope | Behavior |
| --- | --- |
| `session` | Default. Bound to the Pi session that created it. |
| `cwd` | Visible to Pi sessions in the same working directory. Good for project automation. |
| `global` | Visible from any Pi session. |

## Wake behavior for shell tasks

Shell tasks can control when the parent agent is woken:

| `wakeOn` | Behavior |
| --- | --- |
| `always` | Wake after every run if a prompt is configured. |
| `failure` | Wake only when the command exits non-zero or is killed/timed out. |
| `success` | Wake only on exit code 0. |
| `never` | Never wake the agent; just record the result. |

Prompt priority:

1. `successPrompt` on success
2. `failurePrompt` on failure
3. `followUpPrompt` fallback

## Design focus

Pi Scheduler focuses on **scheduled actions**:

- direct scheduled structured shell commands (no shell, allowlisted)
- stdout/stderr passed to the in-memory follow-up prompt only (not persisted)
- success/failure-specific agent wakeups
- bounded command polling with `maxRuns`
- prompt/notify/message actions as lightweight companions

The goal is to make command-driven automation simple: schedule the check, pass the result to the agent, and wake the agent only when useful.

## Important limitations

Pi Scheduler currently uses **in-process timers**:

- If Pi is running, tasks fire at the scheduled time.
- If Pi is closed, tasks do not fire while Pi is closed.
- Pending/missed tasks are loaded again when the relevant Pi session starts, and due tasks fire then.

This is enough for live agent workflows like CI polling while a Pi session is open. A future version could add OS-level `cron`, `at`, launchd, systemd, or a small daemon for exact wakeups while Pi is not running.

## Development

Run tests:

```bash
npm test
```

Check what will be published to npm:

```bash
npm pack --dry-run
```

Load-check the extension locally:

```bash
PI_OFFLINE=1 pi --no-extensions -e ./extensions/scheduler/index.ts --list-models __unlikely_model_filter__
```

Try a command without starting a model turn:

```bash
PI_OFFLINE=1 pi --no-extensions -e ./extensions/scheduler/index.ts --no-session --mode json -p "/schedules"
```

## Scheduled shell execution is deny-by-default

Direct process execution is **disabled by default**. The agent can always
schedule safe actions (`prompt`, `notify`, `message`) without any extra
configuration, but `shell` tasks only run when a user-owned execution policy
explicitly opts in.

The policy lives at:

```text
~/.pi/agent/state/scheduler/scheduler-policy.json
```

If the file is missing or malformed, every `shell` task fails closed. A
legacy command **string** is never interpreted through a shell: it is rejected
and the user must re-create it as a structured command. Only structured
`{ executable, argv }` commands that match an `allow` entry are run, and they
are invoked **directly (no shell)** — `bash -lc ...` is never used.

The policy is loaded **fresh for every scheduling and firing decision** — it is
not cached for the session. So editing, `chmod`/`chown`-ing, or removing the
file takes effect at the next decision without restarting Pi. The file must be
a **regular file owned by the current user**, and on POSIX it must **not be
group- or world-writable** (a writable policy file is rejected and fails
closed). Set restrictive permissions with:

```bash
chmod 600 ~/.pi/agent/state/scheduler/scheduler-policy.json
```

An entry authorizes a command only when the executable matches exactly, the
argv starts with the entry's `argvPrefix`, and the firing `cwd` is contained
beneath the entry's `cwdRoot`. Commands are validated **at scheduling time**
and **revalidated immediately before firing**.

Example policy (allow `npm test` beneath `/path/to/your/project`):

```json
{
  "execution": {
    "enabled": true,
    "allow": [
      { "executable": "npm", "argvPrefix": ["test"], "cwdRoot": "/path/to/your/project" }
    ]
  }
}
```

> **⚠️ `npm run` and other package-script entry points are arbitrary code.** An
> allowlist entry like `{ "executable": "npm", "argvPrefix": ["run"] }` lets the
> scheduler run **any** script defined in the repo's `package.json` — including
> `pre*`/`post*` hooks and scripts added by dependencies — exactly as if you
> had allowlisted a shell. Only allowlist package-script entry points for
> **trusted repositories and specific script names** (for example
> `{ "executable": "npm", "argvPrefix": ["run", "build"] }`), and prefer the
> narrowest `argvPrefix` that does the job. The same caution applies to
> `npx`, `yarn`, `pnpm`, and any launcher that delegates to repo-controlled
> scripts.

Structured shell task example:

```json
{
  "action": "shell",
  "type": "interval",
  "schedule": "5m",
  "name": "repo-tests",
  "command": { "executable": "npm", "argv": ["test"] },
  "cwd": "/repo",
  "wakeOn": "failure",
  "failurePrompt": "Tests failed. Inspect the output and propose a fix.",
  "maxRuns": 10
}
```

For security, scheduled run results do not persist raw `stdout`/`stderr` or
the full command text to the state file — only exit metadata (code, killed,
executable, cwd). Captured output is passed to the in-memory follow-up prompt
only.

## Persistence, claims, and crash recovery

Scheduled tasks are stored in a locked, cross-process task store at
`~/.pi/agent/state/scheduler/tasks.json`. Every load/mutate/save runs inside a
store transaction that serializes read-modify-write and reloads state while the
lock is held, so concurrent Pi sessions cannot lose updates. The cross-process
lock uses **crash-safe, ownership-safe stale recovery via a persistent owner
tombstone**: a reclaimer that observes a stale (dead-owner) lock re-reads it
and requires the exact observed owner/fingerprint, confirms the owner is dead,
and then performs a SINGLE atomic `rename()` of the lock directory to a
deterministic tombstone named after the observed owner token (or inode when the
token is absent). Because that rename is the whole act, a reclaimer crash before
it leaves the dead lock in place for the next reclaimer, and a crash after it
leaves the lock directory free for a new owner while the tombstone is safely
preserved — recovery is never permanently blocked. The tombstone is KEPT
(never auto-deleted) and is non-empty, so a delayed reclaimer that already
observed the same dead owner cannot `rename()` a new live owner's lock onto the
existing tombstone (POSIX `rename()` of a non-empty directory over a non-empty
directory fails with `ENOTEMPTY`). A bounded set of restrictive, owner-only
(`0o700`) `*.tombstone-*` directories (one per distinct dead owner token, a
256-bit random id) may accumulate next to the state file; these are stale,
harmless artifacts that are never read for execution. You may remove old
`*.tombstone-*` directories manually once you are certain no long-delayed
reclaimer for that owner can still run — automatic deletion would reopen the
delayed-reclaimer race.

When a task is due, the runner that owns this Pi process atomically **claims**
it with a stable, unique runner identity and a lease that covers the execution
timeout with margin. **Only the claim owner executes and completes the task.**
If the owning process crashes mid-run, the lease expires and a later runner
recovers the claim automatically; the runtime also arms a bounded lease-expiry
recovery sweep for persisted running tasks so a crashed owner is reclaimed
after its lease expires. A task claimed by a runner that should not execute it
(for example, an out-of-scope task claimed by the wrong session) is
**abandoned**, not marked fired: its claim metadata is cleared and it is
restored to pending without incrementing its run count, so a future eligible
run can pick it up. If a one-shot timer fires but the store claim fails under
contention, the scheduler retries the claim a bounded number of times and then
re-arms the task (with a non-zero delay, never a busy-loop) so it is not
stranded. Cancelling, disabling, or removing a task while a claim is running is
respected by completion: the terminal/disabled state is never resurrected by a
late completion. Safe actions (`prompt`, `notify`, `message`) are unaffected
and remain safe to schedule without any policy.

## Bounded GitHub PR CI / Codex monitoring (prompt-based)

The recommended way to monitor a pull request is **not** to run `gh`/`git` as a
scheduled shell task. Instead schedule a `prompt` action that asks the agent to
check status using the safe wrappers, and bound how many autonomous fix rounds
are attempted. This keeps all GitHub/Git access through `gh_safe` / `git_safe`
and the Codex PR-comment skill.

Recommended workflow:

1. Schedule a recurring `prompt` with `maxRuns` so it stops on its own:

   ```json
   {
     "action": "prompt",
     "type": "interval",
     "schedule": "5m",
     "name": "pr-123-ci",
     "maxRuns": 12,
     "prompt": "Check PR #123 CI status. Use gh_safe pr_view (or gh pr view) with statusCheckRollup. If checks are still pending, do nothing and wait for the next scheduled check. If a check failed, inspect logs with gh_safe and apply a minimal fix; bound yourself to at most 3 autonomous fix attempts before stopping and reporting. If checks pass and review is clean, summarize and let the schedule expire."
   }
   ```

2. Treat `gh` exit code **8** ("pending") as **pending**, not failure. The
   agent should not interpret a pending check as a failed check.

3. Use the **Codex PR-comment skill** (`/skill:codex-pr-comment`) to read and
   action required automated review comments, not a scheduled shell task.

4. Bound autonomous fix rounds explicitly in the prompt (e.g. "at most 3
   attempts") so the agent does not loop indefinitely on a failing check.

This package does **not** invoke the retired `pi-khronos`; all scheduling is
handled by this extension's in-process timers. While a Pi session is open, due
tasks fire at the scheduled time; missed/due tasks fire again when the relevant
session starts.

## Publishing

This package is published as:

```text
@jl1990/pi-scheduler
```

The GitHub Actions workflow `.github/workflows/publish-npm.yml` publishes to npm when a GitHub Release is published.

Release flow:

```bash
npm version patch   # or minor/major
git push --follow-tags
```

Then create/publish a GitHub Release for the new tag. The workflow will run tests, check package contents, and publish with npm provenance.

## Security notes

Scheduled `shell` execution is **deny-by-default** and only runs allowlisted
structured commands directly (no shell). Legacy command strings and any command
not matching the user-owned `scheduler-policy.json` fail closed. Safe actions
(`prompt`, `notify`, `message`) require no policy. Even when allowed, scheduled
run results do not persist raw output or full command text. Only install Pi
packages from sources you trust.
