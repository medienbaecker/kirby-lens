/**
 * One command that runs everything, so verifying is never a manual editor loop.
 *
 * node verify.js          the fast gate: units, PHP, real projects
 * node verify.js --all    also the editor host and the Intelephense server
 *
 * Layers, fastest first:
 *   units         pure functions, no Kirby, no editor
 *   php           docblock parsing, needs a Kirby to bootstrap
 *   corpus        real projects, asserts the exact set of problems reported
 *   intelephense  drives the real language server over stdio
 *   types         re-resolves every recorded receiver type, fails on drift
 *   host          drives a real VS Code extension host (opens a window)
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const all = process.argv.includes("--all");
// The roster is not in the repository; see corpus.js
const local = path.join(__dirname, "corpus.local.json");
const roots = fs.existsSync(local) === true
	? JSON.parse(fs.readFileSync(local, "utf8"))
	: {};
const absolute = (root) => root?.replace(/^~/, require("node:os").homedir());

// These two only need a real Kirby to boot, not the fixture's contents, so any
// project in the roster will do. Without the fallback a missing testbed reads
// as the docblock parser being broken.
const testbed = [roots.testbed, ...Object.values(roots)]
	.map((entry) => absolute(entry?.root))
	.find((root) => root !== undefined && fs.existsSync(root) === true);

const layers = [
	["units", "node", ["test.js"]],
	["units", "node", ["behaviour.js"]],
	["units", "node", ["smoke.js"]],
	["php", "php", [path.join(__dirname, "contract.php"), testbed]],
	["php", "php", [path.join(__dirname, "test.php"), testbed]],
	["corpus", "node", ["corpus.js"]]
];

if (all === true) {
	layers.push(
		["intelephense", "node", [path.join(__dirname, "intelephense.js")]],
		// The recorded receiver types are what corpus.js filters on, so a Kirby
		// or Intelephense upgrade that moves them has to be loud rather than
		// leave the fast gate asserting a stale answer
		["types", "node", ["types.js"]],
		["host", "node", ["host/run.js"]]
	);
}

let failed = 0;

for (const [layer, command, args] of layers) {
	const label = `${layer}: ${path.basename(args[0])}`;

	if (args.includes(undefined) === true) {
		console.log(`\n— ${label}\n  skip  no testbed in corpus.json`);
		continue;
	}

	console.log(`\n— ${label}`);

	const result = spawnSync(command, args, {
		cwd: __dirname,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"]
	});

	const output = ((result.stdout ?? "") + (result.stderr ?? "")).trimEnd();

	for (const line of output.split("\n")) {
		if (/^\s*(ok|FAIL|skip)\s|passed|failed/.test(line) === true) {
			console.log("  " + line.trim());
		}
	}

	if (result.status !== 0) {
		failed++;
		console.log("  ✗ exited " + result.status);
	}
}

console.log(
	failed === 0
		? `\nall ${layers.length} runs green` + (all === false ? " (--all adds the editor and language-server layers)" : "")
		: `\n${failed} of ${layers.length} runs failed`
);

process.exitCode = failed > 0 ? 1 : 0;
