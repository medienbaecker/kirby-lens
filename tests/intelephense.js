/**
 * Drives the installed Intelephense language server over stdio, so the claims
 * the type generator rests on are checked rather than assumed:
 *
 *   1. a `@var` docblock makes $page resolve in a template
 *   2. `@method` on a generated subclass supplies blueprint field names
 *   3. real Kirby methods still resolve through the subclass
 *   4. generating a NEW class costs no duplicate-symbol diagnostic, which is
 *      what redeclaring Kirby\Cms\Page would
 *   5. Intelephense does NOT reject an unknown field or a wrong field method,
 *      because Page::__call and Field::__call exist, which is why the
 *      diagnostics have to be ours. A plain class is checked as a control, so
 *      this proves a gap in Kirby rather than a gap in Intelephense.
 *
 * node tests/intelephense.js
 */

const { spawn } = require("node:child_process");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SERVER = path.join(
	os.homedir(),
	".vscode/extensions/bmewburn.vscode-intelephense-client-1.18.5",
	"node_modules/intelephense/lib/intelephense.js"
);

const KIRBY = path.join(os.homedir(), "Work/Repositories/kirby");
const ROOT = path.join(__dirname, "intelephense/project");
const TEMPLATE = path.join(ROOT, "site/templates/note.php");
const TYPES = path.join(ROOT, ".kirby/types.php");
const uri = (p) => "file://" + p;

if (fs.existsSync(SERVER) === false) {
	console.log("  skip  Intelephense is not installed at the expected path");
	process.exit(0);
}

if (fs.existsSync(KIRBY) === false) {
	console.log(`  skip  no Kirby source to index at ${KIRBY}`);
	process.exit(0);
}

// Kirby's own source has to be indexable or nothing resolves
const link = path.join(ROOT, "kirby");

if (fs.existsSync(link) === false) {
	fs.symlinkSync(KIRBY, link);
}

fs.writeFileSync(
	TYPES,
	`<?php

namespace Kirby\\Types;

/**
 * @method \\Kirby\\Content\\Field headline()
 * @method \\Kirby\\Content\\Field tiptapText()
 */
class NotePage extends \\Kirby\\Cms\\Page
{
}
`
);

fs.writeFileSync(
	TEMPLATE,
	`<?php

/** @var \\Kirby\\Types\\NotePage $page */

$a = $page->headline();
$b = $page->title();
$c = $page->definitelyNotAField();

// The real field method is escape(); Field::__call returns $this for anything
// else, so this silently renders the value UNESCAPED
$d = $page->title()->esc();
`
);

// A class without __call, to show Intelephense is perfectly capable and that
// the gap is specific to Kirby's models
const PLAIN = path.join(ROOT, "site/templates/plain.php");

fs.writeFileSync(
	PLAIN,
	`<?php

final class Plain
{
	public function real(): string
	{
		return 'x';
	}
}

$p = new Plain();
$q = $p->definitelyNotThere();
`
);

const server = spawn("node", [SERVER, "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
const diagnostics = new Map();
let seq = 0;
let buffer = Buffer.alloc(0);

function send(method, params, isRequest = true) {
	const msg = { jsonrpc: "2.0", method, params };

	if (isRequest === true) {
		msg.id = ++seq;
	}

	const body = Buffer.from(JSON.stringify(msg), "utf8");
	server.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
	server.stdin.write(body);

	return isRequest === true
		? new Promise((resolve) => pending.set(msg.id, resolve))
		: Promise.resolve();
}

server.stdout.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);

	while (true) {
		const end = buffer.indexOf("\r\n\r\n");

		if (end === -1) {
			return;
		}

		const match = /Content-Length: (\d+)/i.exec(buffer.slice(0, end).toString());

		if (match === null) {
			return;
		}

		const start = end + 4;
		const length = Number(match[1]);

		if (buffer.length < start + length) {
			return;
		}

		const msg = JSON.parse(buffer.slice(start, start + length).toString("utf8"));
		buffer = buffer.slice(start + length);

		if (msg.id !== undefined && pending.has(msg.id) === true) {
			pending.get(msg.id)(msg.result);
			pending.delete(msg.id);
			continue;
		}

		if (msg.method === "textDocument/publishDiagnostics") {
			diagnostics.set(msg.params.uri, msg.params.diagnostics);
		}
	}
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const check = (name, fn) => {
	try {
		fn();
		pass++;
		console.log("  ok   " + name);
	} catch (e) {
		console.log("  FAIL " + name + "\n       " + e.message);
		process.exitCode = 1;
	}
};

(async () => {
	await send("initialize", {
		processId: process.pid,
		rootUri: uri(ROOT),
		capabilities: { textDocument: { completion: {}, publishDiagnostics: {} } },
		initializationOptions: { storagePath: path.join(os.tmpdir(), "lens-intelephense") }
	});

	await send("initialized", {}, false);
	await wait(1000);

	for (const file of [TYPES, TEMPLATE, PLAIN]) {
		await send("textDocument/didOpen", {
			textDocument: {
				uri: uri(file),
				languageId: "php",
				version: 1,
				text: fs.readFileSync(file, "utf8")
			}
		}, false);
	}

	// Indexing Kirby's source takes a while and there is no ready notification
	await wait(6000);

	const lines = fs.readFileSync(TEMPLATE, "utf8").split("\n");
	const line = lines.findIndex((l) => l.includes("$page->headline"));

	const result = await send("textDocument/completion", {
		textDocument: { uri: uri(TEMPLATE) },
		position: { line, character: lines[line].indexOf("->") + 2 }
	});

	const items = (result?.items ?? result ?? []).map((i) => i.label);

	const errorsIn = (suffix) =>
		[...diagnostics.entries()]
			.filter(([file]) => file.endsWith(suffix))
			.flatMap(([, list]) => list)
			.filter((d) => d.severity <= 2);

	// Only the Kirby files: plain.php is meant to report something
	const errors = [...errorsIn("note.php"), ...errorsIn("types.php")];

	check("a generated @method supplies blueprint field names", () => {
		assert.ok(items.includes("headline"), "headline missing");
		assert.ok(items.includes("tiptapText"), "tiptapText missing");
	});

	check("real Kirby methods still resolve through the subclass", () => {
		assert.ok(items.includes("title"), "title missing");
	});

	check("a new subclass costs no duplicate-symbol diagnostic", () => {
		const dupes = errors.filter((d) => /duplicate/i.test(d.message));
		assert.deepStrictEqual(dupes.map((d) => d.message), []);
	});

	check("Intelephense reports nothing at all on the Kirby files", () => {
		assert.deepStrictEqual(errors.map((d) => d.message), []);
	});

	check("Intelephense does not reject an unknown field, so we must", () => {
		const flagged = errors.filter((d) => /definitelyNotAField/.test(d.message));
		assert.deepStrictEqual(
			flagged.map((d) => d.message),
			[],
			"Intelephense flagged it after all, which would make our field diagnostics redundant"
		);
	});

	// The whole justification for the field diagnostic. `->esc()` does not exist
	// (the method is `escape`) and Field::__call returns $this, so this renders
	// unescaped output with no error anywhere
	check("Intelephense does not reject a wrong field method either", () => {
		const flagged = errors.filter((d) => /esc\b/.test(d.message));
		assert.deepStrictEqual(flagged.map((d) => d.message), []);
	});

	check("but it does flag a typo on a class without __call", () => {
		assert.ok(
			errorsIn("plain.php").some((d) => /definitelyNotThere/.test(d.message)),
			"Intelephense missed an ordinary undefined method, so this probe proves nothing"
		);
	});

	console.log(`\n${pass} passed`);
	server.kill();
	process.exit(process.exitCode ?? 0);
})();
