/**
 * Runs inside the extension host. Everything here goes through the real vscode
 * API, so it checks the wiring the stubbed smoke tests cannot: that VS Code
 * actually calls our providers, at the right positions, with results merged.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

// Reported through a file rather than stdout, because the window is launched
// backgrounded and nothing of its output comes back to the terminal
const REPORT = path.join(os.tmpdir(), "lens-host-report.json");

let pass = 0;
const lines = [];

async function check(name, fn) {
	try {
		await fn();
		pass++;
		lines.push("  ok   " + name);
	} catch (e) {
		lines.push("  FAIL " + name + "\n       " + e.message);
		process.exitCode = 1;
	}
}

const report = (failed) =>
	fs.writeFileSync(REPORT, JSON.stringify({ pass, failed, lines }, null, "\t"));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for a condition rather than a duration.
 *
 * Writing a snippet into the workspace sets the generator running, and so does
 * deleting it again, so any fixed sleep is a bet on how long that takes. The
 * bet was wrong often enough to fail a different assertion on each run.
 */
async function until(what, predicate, timeout = 30000) {
	const deadline = Date.now() + timeout;

	while (Date.now() < deadline) {
		if ((await predicate()) === true) {
			return;
		}

		await wait(250);
	}

	throw new Error("timed out waiting for " + what);
}

async function open(relative) {
	const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
	const uri = vscode.Uri.file(path.join(root, relative));
	const document = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(document);

	return document;
}

/**
 * Completion goes through executeCompletionItemProvider rather than our own
 * function, so a broken trigger character or document selector shows up here.
 */
async function complete(document, needle, offset = 0) {
	const index = document.getText().indexOf(needle) + needle.length + offset;
	const list = await vscode.commands.executeCommand(
		"vscode.executeCompletionItemProvider",
		document.uri,
		document.positionAt(index)
	);

	return (list?.items ?? []).map((i) =>
		typeof i.label === "string" ? i.label : i.label.label
	);
}

exports.run = async function () {
	try {
		await suite();
	} catch (error) {
		lines.push("  FAIL the suite itself\n       " + error.message);
		process.exitCode = 1;
	}

	report(process.exitCode === 1);
};

/**
 * Reports what our provider actually returns at a `{{ page.` cursor in a real
 * project, so a bug someone hits in their own site is answerable by running
 * the host against that site instead of against the fixture.
 *
 * node host/run.js ~/Work/Projects/some-site site/blueprints/fields/image.yml
 */
async function probe(relative) {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const file = vscode.Uri.file(path.join(root, relative));
	const opened = await vscode.workspace.openTextDocument(file);

	await vscode.window.showTextDocument(opened);
	await wait(2000);

	const source = opened.getText();

	// Cmd-click on the first `$page`, which is the other thing a real project is
	// worth asking about
	const receiver = source.indexOf("$page");
	const definitions = receiver === -1
		? null
		: await vscode.commands.executeCommand(
				"vscode.executeDefinitionProvider",
				file,
				opened.positionAt(receiver + 1)
			);

	lines.push(
		"  probe " + relative +
		"\n         workspace=" + root +
		"\n         languageId=" + opened.languageId +
		"\n         $page goes to=" + JSON.stringify(
			(definitions ?? []).map((l) => (l.targetUri ?? l.uri).fsPath.split("/").slice(-3).join("/"))
		)
	);
	pass++;
}

async function suite() {
	const extension = vscode.extensions.getExtension("medienbaecker.kirby-lens");
	assert.ok(extension, "extension not present in the host");
	await extension.activate();

	const config = JSON.parse(
		fs.readFileSync(path.join(os.tmpdir(), "lens-host-probe.json"), "utf8")
	);

	if (config.probe) {
		await probe(config.probe);
		return;
	}

	await check("activates in a Kirby workspace", () => {
		assert.strictEqual(extension.isActive, true);
	});

	const scratch = "site/snippets/host-probe.php";
	const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
	const uri = vscode.Uri.file(path.join(root, scratch));

	await vscode.workspace.fs.writeFile(
		uri,
		Buffer.from(
			"<?php\n" +
				"snippet('components/button', ['variant' => 'filled']);\n" +
				"snippet('components/button', ['variant' => 'otulined']);\n" +
				// A documented key with no value yet, so completing over it has
				// the pair left to write. Documented, so it reports nothing
				"snippet('components/button', ['variant']);\n" +
				// Last, so every line number asserted above stays put
				"snippet('meow');\n"
		)
	);

	const document = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(document);

	await until("the manifest to reach the provider", async () =>
		(await complete(document, "snippet('")).includes("components/button")
	);

	await check("completes snippet names at a real cursor", async () => {
		const labels = await complete(document, "snippet('");
		assert.ok(labels.includes("components/button"), `got ${labels.slice(0, 8)}`);
	});

	await check("completes literal values for a documented key", async () => {
		const labels = await complete(document, "['variant' => '");
		for (const v of ["filled", "outlined", "text"]) {
			assert.ok(labels.includes(v), `${v} missing from ${labels}`);
		}
	});

	// The range and the insert text have to agree in the real editor: VS Code
	// would otherwise overwrite the word at the cursor, which stops at a quote
	await check("completes a key into the pair, ready for its value", async () => {
		const index = document.getText().indexOf("['variant']") + 3;
		const list = await vscode.commands.executeCommand(
			"vscode.executeCompletionItemProvider",
			document.uri,
			document.positionAt(index)
		);

		const item = (list?.items ?? []).find(
			(i) => (typeof i.label === "string" ? i.label : i.label.label) === "variant"
		);

		assert.ok(item, "variant not offered over an existing key");
		assert.strictEqual(item.insertText.value, "'variant' => '$0'");
		assert.strictEqual(
			document.getText(item.range.replacing ?? item.range),
			"'variant'"
		);
		assert.strictEqual(item.command?.command, "editor.action.triggerSuggest");
	});

	await check("publishes a diagnostic for a wrong value", async () => {
		const ours = vscode.languages
			.getDiagnostics(uri)
			.filter((d) => d.source === "kirby-lens");

		assert.strictEqual(ours.length, 2, `got ${ours.map((d) => d.message)}`);

		const value = ours.find((d) => /otulined/.test(d.message));
		assert.ok(value !== undefined, `got ${ours.map((d) => d.message)}`);
		assert.strictEqual(value.range.start.line, 2);

		assert.ok(ours.some((d) => /Snippet "meow" not found/.test(d.message)),
			`got ${ours.map((d) => d.message)}`);
	});

	await check("offers a quick fix for the value it reported", async () => {
		const wrong = document.getText().indexOf("'otulined'");
		const at = new vscode.Range(
			document.positionAt(wrong),
			document.positionAt(wrong + "'otulined'".length)
		);

		const offered = await vscode.commands.executeCommand(
			"vscode.executeCodeActionProvider",
			uri,
			at,
			vscode.CodeActionKind.QuickFix.value
		);

		const titles = (offered ?? []).map((a) => a.title);
		assert.deepStrictEqual(titles[0], "Change to 'outlined'", `got ${titles}`);

		// The edit has to be real, not just a title
		const edits = offered[0].edit.get(uri);
		assert.strictEqual(edits.length, 1);
		assert.strictEqual(edits[0].newText, "'outlined'");
	});

	await check("offers to create a snippet that does not exist", async () => {
		const missing = document.getText().indexOf("'meow'");
		const at = new vscode.Range(
			document.positionAt(missing),
			document.positionAt(missing + "'meow'".length)
		);

		const offered = await vscode.commands.executeCommand(
			"vscode.executeCodeActionProvider",
			uri,
			at,
			vscode.CodeActionKind.QuickFix.value
		);

		const titles = (offered ?? []).map((a) => a.title);

		// Only ours, because every provider's actions are merged in here, and
		// in order, because correcting a typo has to sit above creating a file
		assert.deepStrictEqual(
			titles.filter((t) => /^(Change to|Create snippet) '/.test(t)),
			["Change to 'menu'", "Create snippet 'meow'"],
			`got ${titles}`
		);

		const action = (offered ?? []).find((a) => a.title === "Create snippet 'meow'");
		assert.ok(action !== undefined, `got ${titles}`);

		const created = path.join(root, "site/snippets/meow.php");
		assert.strictEqual(action.command.arguments[0].fsPath, created);

		// A creation is invisible to both edit.get() and edit.size, so applying
		// it is the only thing that tells a wired file operation from no-op
		assert.strictEqual(await vscode.workspace.applyEdit(action.edit), true);
		assert.ok(fs.existsSync(created), "the fix promised a file and made none");

		await vscode.workspace.fs.delete(vscode.Uri.file(created));
		await until("the created snippet to leave the manifest again", async () =>
			(await complete(document, "snippet('")).includes("meow") === false
		);
	});

	await check("renames a snippet across the project and moves its file", async () => {
		const at = document.positionAt(document.getText().indexOf("components/button") + 4);

		const prepared = await vscode.commands.executeCommand(
			"vscode.prepareRename",
			uri,
			at
		);

		assert.strictEqual(prepared.placeholder, "components/button");

		const edit = await vscode.commands.executeCommand(
			"vscode.executeDocumentRenameProvider",
			uri,
			at,
			"components/renamed"
		);

		const here = edit.get(uri);
		assert.strictEqual(here.length, 3, `${here.length} call sites in the probe file`);
		assert.ok(here.every((e) => e.newText === "components/renamed"));

		// The testbed calls this snippet from its own templates and snippets too,
		// so touching only the open file would mean the project was never searched
		const files = edit.entries().map(([target]) => target.fsPath);
		assert.ok(files.length > 1, `only ${files.length} file(s) touched`);
		assert.ok(
			files.some((f) => /site\/templates\/demo\.php$/.test(f)),
			`demo.php not among ${files.length} files`
		);

		// The file move is in the edit as well, but WorkspaceEdit exposes only
		// its text edits, so there is nothing here to assert it against
	});

	await check("hovers a snippet name", async () => {
		const text = document.getText();
		const at = document.positionAt(text.indexOf("components/button") + 4);
		const hovers = await vscode.commands.executeCommand(
			"vscode.executeHoverProvider",
			uri,
			at
		);

		const rendered = hovers
			.flatMap((h) => h.contents.map((c) => c.value ?? c))
			.join("\n");

		assert.match(rendered, /variant/);
	});

	await check("resolves a snippet name to its file", async () => {
		const at = document.positionAt(document.getText().indexOf("components/button") + 4);
		let locations = [];

		// Polled rather than asked once. About one run in six came back empty
		// here, with the manifest provably populated at that moment and every
		// other assertion green, so the emptiness is in the request rather than
		// in what we answer with. Cause not established.
		await until("a definition for components/button", async () => {
			locations = await vscode.commands.executeCommand(
				"vscode.executeDefinitionProvider",
				uri,
				at
			);

			return (locations?.length ?? 0) >= 1;
		});

		const link = locations[0];
		assert.match(link.targetUri.fsPath, /site\/snippets\/components\/button\.php$/);

		// The whole path must be one link. Falling back to PHP's word pattern
		// splits it at the slash into two links with a dead character between
		assert.ok(link.originSelectionRange, "no origin range, so the slash breaks the link");
		assert.strictEqual(
			document.getText(link.originSelectionRange),
			"components/button"
		);
	});

	await vscode.workspace.fs.delete(uri);

	// A template binds to a blueprint by name, so the fields offered here are
	// that blueprint's rather than every field in the project
	const template = vscode.Uri.file(path.join(root, "site/templates/default.php"));
	const before = await vscode.workspace.fs.readFile(template);

	await vscode.workspace.fs.writeFile(
		template,
		Buffer.concat([before, Buffer.from("\n<?php $page->; ?>\n")])
	);

	const bound = await vscode.workspace.openTextDocument(template);
	await vscode.window.showTextDocument(bound);

	// Deleting the scratch snippet set the generator running again
	await until("the field completions to settle", async () =>
		(await complete(bound, "$page->")).includes("title_menu")
	);

	await check("completes blueprint fields after a receiver", async () => {
		const labels = await complete(bound, "$page->");
		assert.ok(labels.length > 0, "no field completions");
		assert.ok(
			labels.includes("title_menu"),
			`pages/default fields missing, got ${labels.slice(0, 10)}`
		);
	});

	await vscode.workspace.fs.writeFile(
		template,
		Buffer.concat([before, Buffer.from("\n<?php $page->og()->; ?>\n")])
	);

	const chained = await vscode.workspace.openTextDocument(template);
	await vscode.window.showTextDocument(chained);

	await until("the edited buffer to reach the provider", async () =>
		chained.getText().includes("$page->og()->")
	);

	await check("leads with the conversion that suits the field type", async () => {
		const list = await vscode.commands.executeCommand(
			"vscode.executeCompletionItemProvider",
			template,
			chained.positionAt(chained.getText().indexOf("$page->og()->") + 13)
		);

		// VS Code merges its own PHP word suggestions in, so match on the detail
		// only this provider sets. og is a files field in the testbed.
		const items = list?.items ?? [];
		const preferred = items.filter((i) => i.detail === "files field");
		const label = (i) => (typeof i.label === "string" ? i.label : i.label.label);

		assert.deepStrictEqual(
			preferred.map(label).sort(),
			["toFile", "toFiles"],
			`got ${items.filter((i) => i.detail).map(label).slice(0, 8)}`
		);

		// Must sort above a snippet prefix like `->clone()`, which starts with
		// `-` (ASCII 45) and would otherwise beat any digit
		assert.ok(preferred.every((i) => i.sortText < "->clone()"), "sorts below snippet prefixes");
	});

	await vscode.workspace.fs.writeFile(template, before);

	const blueprint = vscode.Uri.file(path.join(root, "site/blueprints/pages/probe.yml"));

	await vscode.workspace.fs.writeFile(
		blueprint,
		Buffer.from("title: Probe\nfields:\n  hero:\n    extends: fields/headline\n")
	);

	const yaml = await vscode.workspace.openTextDocument(blueprint);
	await vscode.window.showTextDocument(yaml);
	await wait(800);

	await check("resolves a blueprint extends to its file", async () => {
		const at = yaml.positionAt(yaml.getText().indexOf("fields/headline") + 2);
		const locations = await vscode.commands.executeCommand(
			"vscode.executeDefinitionProvider",
			blueprint,
			at
		);

		assert.ok(locations?.length >= 1, "no definition returned for extends");
		const link = locations[0];
		assert.match(link.targetUri.fsPath, /site\/blueprints\/fields\/headline\.yml$/);

		// `fields/headline` splits at the slash too without an origin range
		assert.strictEqual(yaml.getText(link.originSelectionRange), "fields/headline");
	});

	// Diagnostics on YAML are a whole surface of their own: refreshDiagnostics
	// rejected everything that was neither PHP nor a content file, so nothing
	// here reaches the editor unless that guard and the blueprints-root test
	// both hold. The corpus proves the analyser and says nothing about this.
	const fieldset = vscode.Uri.file(path.join(root, "site/blueprints/blocks/probe.yml"));

	await vscode.workspace.fs.writeFile(
		fieldset,
		Buffer.from('name: Probe\nlabel: "{{ nosuchfield }}"\nfields:\n  headline:\n    type: text\n')
	);

	const block = await vscode.workspace.openTextDocument(fieldset);
	await vscode.window.showTextDocument(block);

	await until("the block label diagnostic to be published", async () =>
		vscode.languages.getDiagnostics(fieldset).some((d) => d.source === "kirby-lens")
	);

	await check("publishes a block label diagnostic in a blueprint", async () => {
		const ours = vscode.languages
			.getDiagnostics(fieldset)
			.filter((d) => d.source === "kirby-lens");

		assert.strictEqual(ours.length, 1, `got ${ours.map((d) => d.message)}`);
		assert.match(ours[0].message, /Field "nosuchfield" not found in this block/);

		// On the name itself, not on the line or the braces
		assert.strictEqual(block.getText(ours[0].range), "nosuchfield");
	});

	await check("leaves other YAML in the workspace alone", async () => {
		const outside = vscode.Uri.file(path.join(root, "probe-outside.yml"));

		await vscode.workspace.fs.writeFile(
			outside,
			Buffer.from('label: "{{ nosuchfield }}"\n')
		);

		const other = await vscode.workspace.openTextDocument(outside);
		await vscode.window.showTextDocument(other);
		await wait(1200);

		const ours = vscode.languages
			.getDiagnostics(outside)
			.filter((d) => d.source === "kirby-lens");

		await vscode.workspace.fs.delete(outside);
		assert.deepStrictEqual(ours.map((d) => d.message), []);
	});

	await vscode.workspace.fs.delete(fieldset);

}
