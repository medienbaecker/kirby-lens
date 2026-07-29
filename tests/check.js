/**
 * Every problem Kirby Lens can find in a whole project, printed.
 *
 *   node check.js ~/Work/Projects/some-site
 *   node check.js .                     # the project you are standing in
 *
 * The editor publishes diagnostics per document, so it only ever shows problems
 * for files that happen to be open. This is the same set of checks over the
 * whole site at once, which is the only way to answer "is anything wrong here".
 *
 * Nothing is written into the project: the manifest goes to a temp file, the
 * same way corpus.js reads the projects it measures.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { problems } = require("../project.js");

const isKirby = (dir) =>
	fs.existsSync(path.join(dir, "kirby/bootstrap.php")) ||
	fs.existsSync(path.join(dir, "vendor/getkirby/cms/bootstrap.php"));

/**
 * The project a path is inside, walking up the way the generator's own
 * bootstrap does, so this runs from anywhere within a site rather than only
 * from its root. Standing in the project and typing the command is the whole
 * point of it existing.
 */
function projectAbove(from) {
	let at = path.resolve(from.replace(/^~/, os.homedir()));

	while (at !== path.dirname(at)) {
		if (isKirby(at) === true) {
			return at;
		}

		at = path.dirname(at);
	}

	return null;
}

const from = process.argv[2] ?? process.cwd();
const root = projectAbove(from);

if (root === null) {
	console.error(`No Kirby installation in or above ${path.resolve(from)}`);
	process.exit(2);
}

const out = path.join(os.tmpdir(), "lens-check.json");

try {
	execFileSync("php", [path.join(__dirname, "../php/generate.php"), root, out], { stdio: "pipe" });
} catch (error) {
	console.error("Could not read the project:\n" + (error.stderr?.toString() ?? error.message));
	process.exit(1);
}

const index = JSON.parse(fs.readFileSync(out, "utf8"));
const found = problems(root, index)
	.map((problem) => `${problem.file}: ${problem.message}`)
	.sort();

// Grouped by file, because a wall of paths repeated forty times is what makes a
// long report unreadable
const byFile = new Map();

for (const problem of found) {
	const at = problem.indexOf(": ");
	const file = problem.slice(0, at);

	byFile.set(file, [...(byFile.get(file) ?? []), problem.slice(at + 2)]);
}

console.log(`\n${path.basename(root)} — Kirby ${index.kirby}\n`);

for (const [file, messages] of byFile) {
	console.log(`  ${file}`);

	for (const message of messages) {
		console.log(`    ${message}`);
	}

	console.log("");
}

console.log(
	found.length === 0
		? "  nothing found\n"
		: `  ${found.length} problem${found.length === 1 ? "" : "s"} in ${byFile.size} file${byFile.size === 1 ? "" : "s"}\n`
);
