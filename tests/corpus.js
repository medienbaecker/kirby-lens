/**
 * Runs the analyser over real Kirby projects and asserts the exact set of
 * problems it reports, so a change that starts flagging correct code fails here
 * rather than in someone's editor.
 *
 * Manifests are generated to a temp directory, never into the projects.
 *
 * node corpus.js            check every project in corpus.json
 *
 * The roots live in corpus.local.json, which is not in the repository: the paths
 * and the directory names are a client list. The expectations are not, so they
 * stay versioned and `git diff` remains the review step before a --write.
 * node corpus.js --report   print what it finds
 * node corpus.js --write    record what it finds as the new expectations
 *
 * Only ever --write after reading the diff.
 *
 * Most expectations are real bugs, checked by hand against the project's own
 * CSS, blueprints or snippet source. Two groups are knowingly not:
 *
 * KirbyTags in the default `all` mode report every unregistered `(word: …)`.
 * `pdf ×10` and `e-mail` are real; `auch`, `also`, `enlace`, `ESP`,
 * `ehemalige` and `Navi-Adresse` are parenthetical prose that Kirby also treats
 * as tag attempts and renders as plain text.
 *
 * `logs` in one project is Uniform's magic `__call`, which forwards to Action
 * classes. Nothing static can know what a `__call` accepts. `logAction` and
 * `emailAction` were the same case and are gone: their receiver resolves to
 * `\Uniform\Form`, which is no kind of Kirby model, so the type filter rules
 * them out. `logs` hangs off nothing a type can be had for.
 *
 * The language-gap entries are facts rather than bugs: one project's Danish,
 * Spanish and Turkish files are deliberately partial. They are recorded so that a key going
 * missing from a language that was complete still shows up here.
 *
 * The two `dreamform.*` keys are real bugs in a third-party plugin, referenced
 * in its PHP and shipped in none of its translation files.
 *
 * They are recorded so a change in behaviour still shows up here.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { CONVERSIONS } = require("../analyze.js");
const { files, findings } = require("../project.js");

const CORPUS = path.join(__dirname, "corpus.json");
const TYPES = path.join(__dirname, "types.json");
const LOCAL = path.join(__dirname, "corpus.local.json");
const report = process.argv.includes("--report");
const write = process.argv.includes("--write");

// A short path, because a long one breaks nothing here but keeps parity with
// the editor harness, which cannot exceed the ~104 byte unix socket limit
const OUT = path.join(os.tmpdir(), "lens-corpus");

const read = (file) =>
	fs.existsSync(file) === true ? JSON.parse(fs.readFileSync(file, "utf8")) : {};

// The testbed is the repository's own and its expectations are versioned here.
// Everything else names a real project, in its paths as much as in its key, so
// it lives in a file that is never committed.
const publicly = read(CORPUS);
const privately = read(LOCAL);

const corpus = {};

for (const name of new Set([...Object.keys(publicly), ...Object.keys(privately)])) {
	corpus[name] = { ...publicly[name], ...privately[name] };
}

const rootOf = (name) =>
	corpus[name]?.root === undefined
		? null
		: corpus[name].root.replace(/^~/, os.homedir());

// Locally the real directory name is far more use than `gamma`
const labelOf = (name) => {
	const root = rootOf(name);
	return root === null ? name : path.basename(root);
};

// Receiver types the editor gets from Intelephense, recorded by types.js so the
// baseline here is the set a real window shows rather than a superset of it
const types = { ...read(TYPES), ...read(TYPES.replace(/\.json$/, ".local.json")) };

let pass = 0;
let fail = 0;

const GENERATOR = path.join(__dirname, "../php/generate.php");

/**
 * Via the standalone generator rather than `kirby lens:generate`, so the
 * plugin never has to be installed into a project the harness is only reading.
 */
function manifest(root, name) {
	const out = path.join(OUT, name + ".json");

	execFileSync("php", [GENERATOR, root, out], { stdio: "pipe" });

	return JSON.parse(fs.readFileSync(out, "utf8"));
}


/**
 * CONVERSIONS is the one table in this project that is editorial rather than
 * read from Kirby, so it is checked against every real project: a renamed field
 * type or field method fails here instead of quietly losing its preference.
 */
function drift(name, index) {
	const types = new Set(index.fieldTypes ?? []);
	const methods = new Set(Object.keys(index.fieldMethods ?? {}));

	if (types.size === 0 || methods.size === 0) {
		return;
	}

	for (const [type, preferred] of Object.entries(CONVERSIONS)) {
		if (types.has(type) === false) {
			console.log(`  warn ${name}: CONVERSIONS has "${type}", which is not a field type here`);
		}

		for (const method of preferred) {
			if (methods.has(method) === false) {
				console.log(`  warn ${name}: CONVERSIONS maps ${type} to "${method}", which is not a field method`);
			}
		}
	}
}

if (require.main === module) {
	for (const [name, project] of Object.entries(corpus)) {
		const root = rootOf(name);
		const label = labelOf(name);

		if (root === null || fs.existsSync(root) === false) {
			console.log(`  skip ${label}`);
			continue;
		}

		const index = manifest(root, name);

		drift(label, index);

		const actual = findings(root, index, types[name] ?? {});

		if (report === true || write === true) {
			console.log(`\n${label} (${actual.length})`);
			for (const line of actual) console.log("  " + JSON.stringify(line));
			project.expect = actual;
			continue;
		}

		const expected = [...project.expect].sort();
		const missing = expected.filter((e) => actual.includes(e) === false);
		const extra = actual.filter((a) => expected.includes(a) === false);

		if (missing.length === 0 && extra.length === 0) {
			pass++;
			console.log(`  ok   ${label} (${actual.length} problems, all expected)`);
			continue;
		}

		fail++;
		console.log(`  FAIL ${label}`);
		for (const m of missing) console.log(`       missed:     ${m}`);
		for (const e of extra) console.log(`       unexpected: ${e}`);
	}

	if (write === true) {
		// Split back the way it was read, so nothing private lands in the repository
		const out = { testbed: { expect: corpus.testbed?.expect ?? [] } };
		const mine = {};

		for (const [name, project] of Object.entries(corpus)) {
			mine[name] = name === "testbed"
				? { root: project.root }
				: { root: project.root, expect: project.expect };
		}

		fs.writeFileSync(CORPUS, JSON.stringify(out, null, "\t") + "\n");
		fs.writeFileSync(LOCAL, JSON.stringify(mine, null, "\t") + "\n");
		console.log(`\nrecorded to ${path.basename(CORPUS)} and ${path.basename(LOCAL)}`);
	} else if (report === false) {
		console.log(`\n${pass} passed, ${fail} failed`);
		process.exitCode = fail > 0 ? 1 : 0;
	}
}
