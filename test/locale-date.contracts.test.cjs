// Test-first contract: the absolute-time formatter used by the scheduler must be
// deterministic regardless of the host locale. The baseline `formatAbsoluteTime`
// in scheduler-core.cjs delegates to `toLocaleDateString`, which on Dave's
// machine produces `10 Jul` (day-first) but the original test asserted `Jul 10`
// (month-first) — a locale-dependent failure.
//
// This contract test pins the required behavior: the "beyond tomorrow" branch
// must render a stable, locale-independent month-then-day form regardless of the
// `LANG`/`LC_TIME`/`LC_ALL` environment the process runs under.
//
// Until the implementation is hardened (step that owns date formatting), this
// test fails for the intended reason: locale-dependent output.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

const CORE_PATH = join(
	__dirname,
	"..",
	"extensions",
	"scheduler",
	"scheduler-core.cjs",
);

function formatInLocale(env) {
	const script = [
		`const { formatAbsoluteTime } = require(${JSON.stringify(CORE_PATH)});`,
		`const now = new Date("2026-07-05T12:00:00Z");`,
		`const later = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);`,
		`process.stdout.write(formatAbsoluteTime(later.toISOString(), now));`,
	].join("\n");
	const result = spawnSync(process.execPath, ["-e", script], {
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
	if (result.status !== 0)
		throw new Error(`locale worker failed: ${result.stderr || result.stdout}`);
	return result.stdout.trim();
}

test("formatAbsoluteTime 'on <date>' branch is locale-independent (month then day)", () => {
	// Run the same formatter under two strongly different locales and require
	// byte-identical output. A locale-dependent implementation will diverge.
	const enUS = formatInLocale({
		LANG: "en_US.UTF-8",
		LC_ALL: "en_US.UTF-8",
		LC_TIME: "en_US.UTF-8",
	});
	const enGB = formatInLocale({
		LANG: "en_GB.UTF-8",
		LC_ALL: "en_GB.UTF-8",
		LC_TIME: "en_GB.UTF-8",
	});

	assert.equal(
		enUS,
		enGB,
		"absolute time formatting must be identical across locales; got divergent output",
	);

	// The deterministic form must be month-then-day (e.g. "on Jul 10 at 12:00").
	assert.match(
		enUS,
		/^on [A-Z][a-z]{2} \d+ at \d{2}:\d{2}$/,
		`expected a stable month-then-day form; got: ${enUS}`,
	);
});

test("formatAbsoluteTime same-day and tomorrow branches remain stable across locales", () => {
	const script = (offsetMs) =>
		[
			`const { formatAbsoluteTime } = require(${JSON.stringify(CORE_PATH)});`,
			`const now = new Date("2026-07-05T12:00:00Z");`,
			`const target = new Date(now.getTime() + ${offsetMs});`,
			`process.stdout.write(formatAbsoluteTime(target.toISOString(), now));`,
		].join("\n");

	const run = (offsetMs, env) => {
		const r = spawnSync(process.execPath, ["-e", script(offsetMs)], {
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
		if (r.status !== 0)
			throw new Error(`locale worker failed: ${r.stderr || r.stdout}`);
		return r.stdout.trim();
	};

	const sameDayUS = run(3 * 60 * 60 * 1000, {
		LANG: "en_US.UTF-8",
		LC_ALL: "en_US.UTF-8",
	});
	const sameDayGB = run(3 * 60 * 60 * 1000, {
		LANG: "en_GB.UTF-8",
		LC_ALL: "en_GB.UTF-8",
	});
	assert.equal(
		sameDayUS,
		sameDayGB,
		"same-day formatting must be locale-independent",
	);

	const tomorrowUS = run(24 * 60 * 60 * 1000, {
		LANG: "en_US.UTF-8",
		LC_ALL: "en_US.UTF-8",
	});
	const tomorrowGB = run(24 * 60 * 60 * 1000, {
		LANG: "en_GB.UTF-8",
		LC_ALL: "en_GB.UTF-8",
	});
	assert.equal(
		tomorrowUS,
		tomorrowGB,
		"tomorrow formatting must be locale-independent",
	);
});
