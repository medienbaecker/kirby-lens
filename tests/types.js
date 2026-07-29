/**
 * Records the receiver type behind every field finding in the corpus.
 *
 *   node types.js            check the recording against the language server
 *   node types.js --write    record what it resolves now
 *
 * The editor asks Intelephense for a receiver's type and drops a finding whose
 * receiver is provably not a model. `corpus.js` has to apply the same filter or
 * its baseline stops being what a window shows, which is how the plugin wall
 * went unnoticed. A live server in that loop would cost minutes across eleven
 * projects, so the answers are recorded here instead and the loop stays fast.
 *
 * The recording can go stale against a Kirby or Intelephense upgrade, which is
 * what the check mode is for. `verify:all` runs it.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { serverPath, start, uri, wait, position, typeOf } = require("./lsp.js");
const { problems } = require("../project.js");

const CORPUS = path.join(__dirname, "corpus.json");
const LOCAL = path.join(__dirname, "corpus.local.json");
const TYPES = path.join(__dirname, "types.json");
const TYPES_LOCAL = path.join(__dirname, "types.local.json");
const OUT = path.join(os.tmpdir(), "lens-types");
const GENERATOR = path.join(__dirname, "../php/generate.php");

const write = process.argv.includes("--write");

/**
 * A finding is keyed by where it is rather than by what it says, so rewording a
 * message never invalidates the recording.
 */
const key = (file, receiver) => `${file}:${receiver.start}`;

async function resolve(server, root, index) {
	const found = {};
	const wanted = new Map();

	for (const problem of problems(root, index)) {
		if (problem.receiver == null || /Field or method/.test(problem.message) === false) {
			continue;
		}

		const file = path.join(root, problem.file);

		if (wanted.has(file) === false) {
			wanted.set(file, []);
		}

		wanted.get(file).push(problem);
	}

	for (const [file, list] of wanted) {
		const text = fs.readFileSync(file, "utf8");

		await server.send(
			"textDocument/didOpen",
			{ textDocument: { uri: uri(file), languageId: "php", version: 1, text } },
			false
		);

		await wait(1200);

		// One answer per variable, because a single CLI command file asked the
		// same question about `$cli` thirty-four times
		const seen = new Map();

		for (const problem of list) {
			const name = problem.receiver.name;

			if (seen.has(name) === false) {
				const hover = await server.send("textDocument/hover", {
					textDocument: { uri: uri(file) },
					position: position(text, problem.receiver.start)
				});

				seen.set(name, typeOf(hover));
			}

			const type = seen.get(name);

			if (type !== null) {
				found[key(problem.file, problem.receiver)] = type;
			}
		}
	}

	return found;
}

async function main() {
	const server = serverPath();

	if (server === null) {
		console.log("  skip  Intelephense is not installed");
		return;
	}

	const read = (file) =>
		fs.existsSync(file) === true ? JSON.parse(fs.readFileSync(file, "utf8")) : {};

	// Public half and private half, merged to work with and split to write; see corpus.js
	const corpus = { ...read(CORPUS), ...read(LOCAL) };
	const recorded = { ...read(TYPES), ...read(TYPES_LOCAL) };

	const found = {};
	let drift = 0;

	fs.mkdirSync(OUT, { recursive: true });

	for (const name of Object.keys(corpus)) {
		const root = corpus[name]?.root?.replace(/^~/, os.homedir());

		if (root === undefined || fs.existsSync(root) === false) {
			console.log(`  skip  ${name}`);
			continue;
		}

		const label = path.basename(root);

		const manifest = path.join(OUT, name + ".json");
		execFileSync("php", [GENERATOR, root, manifest], { stdio: "pipe" });
		const index = JSON.parse(fs.readFileSync(manifest, "utf8"));

		const client = start(server);

		await client.send("initialize", {
			processId: process.pid,
			rootUri: uri(root),
			capabilities: { textDocument: { hover: { contentFormat: ["markdown", "plaintext"] } } },
			initializationOptions: { storagePath: path.join(OUT, "iph-" + name) }
		});

		await client.send("initialized", {}, false);

		// Indexing a whole project takes a while and there is no ready notification
		await wait(12000);

		found[name] = await resolve(client, root, index);
		client.kill();

		const before = JSON.stringify(recorded[name] ?? {});
		const after = JSON.stringify(found[name]);
		const same = before === after;

		if (same === false) {
			drift++;
		}

		console.log(
			`  ${same === true ? "ok  " : write === true ? "rec " : "DRIFT"} ${label} ` +
				`(${Object.keys(found[name]).length} resolved)`
		);
	}

	if (write === true) {
		const testbed = found.testbed === undefined ? {} : { testbed: found.testbed };
		const mine = Object.fromEntries(
			Object.entries(found).filter(([name]) => name !== "testbed")
		);

		fs.writeFileSync(TYPES, JSON.stringify(testbed, null, "\t") + "\n");
		fs.writeFileSync(TYPES_LOCAL, JSON.stringify(mine, null, "\t") + "\n");
		console.log(`\nrecorded to ${path.basename(TYPES)} and ${path.basename(TYPES_LOCAL)}`);
		return;
	}

	if (drift > 0) {
		console.log(`\n${drift} project(s) drifted. Read the diff, then: node types.js --write`);
		process.exitCode = 1;
	}
}

if (require.main === module) {
	main();
}

module.exports = { key };
