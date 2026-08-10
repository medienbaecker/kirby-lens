/**
 * Runs the suite inside a real VS Code extension host, so the parts that only
 * exist in an editor (trigger characters, provider registration, definition
 * resolution, diagnostic ranges) are checked without anyone reloading a window.
 *
 * node host/run.js
 *
 * macOS has no headless extension host, so a window does open for a few
 * seconds. It is launched through `open -g` so that it never takes focus, which
 * costs us its stdout: the suite writes its results to a file instead. Still a
 * pre-publish gate rather than the loop you run on every change; `npm test` and
 * `npm run corpus` cover the logic and stay headless.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const APP = "/Applications/Visual Studio Code.app";
// VS Code renamed this from Electron to Code, and the skip that costs is
// silent: the whole host layer simply stops running
const CODE = ["Code", "Electron"]
	.map((name) => path.join(APP, "Contents/MacOS", name))
	.find((file) => fs.existsSync(file)) ?? path.join(APP, "Contents/MacOS/Code");
// Any project, not only the testbed. A bug reported in someone's own site is
// answerable by running the real host against that site rather than by
// reasoning about how it differs from the fixture.
//   node host/run.js ~/Work/Projects/some-site site/blueprints/fields/image.yml
//
// `--project` in place of a file runs the whole-project command against that
// workspace and nothing else, which is the one mode that needs Intelephense:
//   node host/run.js ~/Work/Projects/some-site --project
const WORKSPACE = process.argv[2]
	? path.resolve(process.argv[2].replace(/^~/, os.homedir()))
	: path.join(os.homedir(), "Work/Projects/test-snippy");

const MODE = process.argv[3] === "--project" ? "project" : "";
const PROBE = MODE === "" ? (process.argv[3] ?? "") : "";
const REPORT = path.join(os.tmpdir(), "lens-host-report.json");

// A macOS unix socket path caps out around 104 bytes and VS Code puts one
// inside the user data dir, so this cannot live under a long scratch path
const USER_DATA = path.join(os.tmpdir(), "lens-host");

for (const [what, where] of [["VS Code", CODE], ["workspace", WORKSPACE]]) {
	if (fs.existsSync(where) === false) {
		console.log(`  skip  no ${what} at ${where}`);
		process.exit(0);
	}
}

fs.rmSync(USER_DATA, { recursive: true, force: true });
fs.mkdirSync(USER_DATA, { recursive: true });

fs.rmSync(REPORT, { force: true });

// Through a file rather than the environment: `open` hands the app to
// LaunchServices, which does not carry one
fs.writeFileSync(
	path.join(os.tmpdir(), "lens-host-probe.json"),
	JSON.stringify({ workspace: WORKSPACE, probe: PROBE, mode: MODE })
);

const args = [
	`--extensionDevelopmentPath=${path.join(__dirname, "../..")}`,
	`--extensionTestsPath=${path.join(__dirname, "suite.js")}`,
	`--user-data-dir=${USER_DATA}`,
	// Kept off for --project: the type filter is Intelephense's answer, so
	// disabling extensions there would test a check that suppresses nothing
	...(MODE === "project" ? [] : ["--disable-extensions"]),
	"--disable-gpu",
	WORKSPACE
];

// -g keeps it off the foreground, -n forces a fresh instance rather than
// handing the folder to the editor already open, -W waits for it to quit
const result = spawnSync("open", ["-g", "-n", "-W", "-a", APP, "--args", ...args], {
	encoding: "utf8"
});

if (fs.existsSync(REPORT) === false) {
	console.log("  FAIL the host never reported");
	console.log("       " + ((result.stderr ?? "").trim() || "no output from open"));
	process.exitCode = 1;
	process.exit(1);
}

const { pass, failed, lines } = JSON.parse(fs.readFileSync(REPORT, "utf8"));

for (const line of lines) {
	console.log(line);
}

console.log(`\n${pass} passed`);

if (failed === true) {
	console.log("host run did not report success");
	process.exitCode = 1;
}
