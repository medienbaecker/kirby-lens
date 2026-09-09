const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const {
	complete,
	diagnose,
	hover,
	define,
	defineBlueprint,
	defineTranslation,
	keyLine,
	diagnoseFields,
	diagnoseBlockLabels,
	completeFields,
	completeFieldMethods,
	ROOTS,
	ownCode,
	suppresses,
	fixes,
	renameEdits,
	diagnoseTranslations,
	diagnoseCollections,
	completeTranslations,
	previewTranslations
} = require("./analyze.js");

/**
 * A vscode adapter over analyze.js.
 */

/** @type {Record<string, Record<string, object>>} */
let manifest = {};

const KINDS = {
	name: vscode.CompletionItemKind.File,
	key: vscode.CompletionItemKind.Property,
	value: vscode.CompletionItemKind.EnumMember,
	field: vscode.CompletionItemKind.Field,
	method: vscode.CompletionItemKind.Method
};

const SEVERITIES = {
	error: vscode.DiagnosticSeverity.Error,
	warning: vscode.DiagnosticSeverity.Warning,
	// A language that is only partly translated is true and may be deliberate
	information: vscode.DiagnosticSeverity.Information
};

function config(key) {
	return vscode.workspace.getConfiguration("kirbyLens").get(key);
}

function workspaceRoot() {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

/* ------------------------------------------------------------------ */
/* Manifest                                                            */
/* ------------------------------------------------------------------ */

function manifestPath() {
	const root = workspaceRoot();
	return root === null ? null : path.join(root, config("manifest"));
}

function loadManifest() {
	const file = manifestPath();

	// Never downgrades: a missing manifest means a rewrite in progress, not a
	// project without snippets
	if (file === null || fs.existsSync(file) === false) {
		return;
	}

	try {
		manifest = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		// Keeping the last good one: this is nearly always a read racing a write
		console.error("[kirby-lens] manifest unreadable:", error.message);
	}
}

// The same two locations the generator bootstraps from, so the halves cannot
// disagree. A roots check could not work: roots are only known from a manifest.
function isKirbyProject(root) {
	return (
		fs.existsSync(path.join(root, "kirby/bootstrap.php")) ||
		fs.existsSync(path.join(root, "vendor/getkirby/cms/bootstrap.php"))
	);
}

/**
 * An absolute path to one of the project's roots.
 */
function rootPath(name) {
	const root = workspaceRoot();

	if (root === null) {
		return null;
	}

	const dir = manifest.roots?.[name] ?? ROOTS[name];

	return path.isAbsolute(dir) ? dir : path.join(root, dir);
}

let warned = false;

/**
 * Once per session, because the generator runs on every snippet change and
 * would otherwise warn on every keystroke.
 */
function warn(error, stderr) {
	if (warned === true) {
		return;
	}

	warned = true;

	vscode.window.showWarningMessage(
		error.code === "ENOENT"
			? `Kirby Lens could not run "${config("php")}". Set kirbyLens.php to your PHP binary.`
			: "Kirby Lens could not read this project: " + (stderr || error.message).trim()
	);
}

/**
 * The generator ships with the extension and boots the project's own Kirby,
 * so nothing has to be installed into the project.
 */
function regenerate(done) {
	const root = workspaceRoot();

	if (root === null || isKirbyProject(root) === false) {
		return;
	}

	const script = path.join(__dirname, "php/generate.php");
	const target = manifestPath();

	execFile(config("php"), [script, root, target], { cwd: root }, (error, stdout, stderr) => {
		if (error) {
			warn(error, stderr);
			return;
		}

		loadManifest();
		done?.();
	});
}

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

const items = (suggestions, document) =>
	suggestions.map((suggestion) => {
		const item = new vscode.CompletionItem(suggestion.label, KINDS[suggestion.kind]);
		item.detail = suggestion.detail;
		item.documentation = suggestion.documentation || undefined;

		// Without this VS Code sorts by its own fuzzy score, which would bury
		// toStructure() among the sixty methods that fit any field
		if (suggestion.sort !== undefined) {
			item.sortText = suggestion.sort;
		}

		if (suggestion.insert !== undefined) {
			item.insertText = new vscode.SnippetString(suggestion.insert);
		}

		// The default range is the word at the cursor, which stops at a quote
		if (suggestion.replace !== undefined && document !== undefined) {
			item.range = new vscode.Range(
				document.positionAt(suggestion.replace.start),
				document.positionAt(suggestion.replace.end)
			);

			// Filtering happens against the text that range covers, quotes
			// included, so without this every item is filtered out
			item.filterText = suggestion.filter;
		}

		// A key whose values are known lands inside empty quotes, so the list of
		// them is worth opening without asking
		if (suggestion.retrigger === true) {
			item.command = {
				command: "editor.action.triggerSuggest",
				title: "Values"
			};
		}

		if (suggestion.preselect === true) {
			item.preselect = true;
		}

		return item;
	});

const upto = (document, position) =>
	document.getText(new vscode.Range(new vscode.Position(0, 0), position));

/**
 * The two contexts are mutually exclusive: one needs an unterminated string
 * inside a `snippet()` call, the other a `->` at the cursor.
 */
const completion = {
	provideCompletionItems(document, position) {
		const text = upto(document, position);
		const root = workspaceRoot();
		const file = root === null ? "" : path.relative(root, document.uri.fsPath);

		return items(
			[
				// The whole document, because a name already written is worth
				// completing over. The two after it read backwards from the
				// cursor by nature: what follows a `->` cannot inform it
				...complete(document.getText(), manifest, document.offsetAt(position)),
				...completeTranslations(document.getText(), manifest, document.offsetAt(position)),
				...completeFields(text, manifest, file),
				...completeFieldMethods(text, manifest, file)
			],
			document
		);
	}
};

const hovers = {
	provideHover(document, position) {
		const result = hover(document.getText(), document.offsetAt(position), manifest);

		if (result === null) {
			return;
		}

		return new vscode.Hover(
			new vscode.MarkdownString(result.contents),
			new vscode.Range(
				document.positionAt(result.start),
				document.positionAt(result.end)
			)
		);
	}
};

/**
 * What a cmd-click leads to: the range to underline, and every file it could
 * open with an offset to land on.
 */
function resolveDefinition(document, offset) {
	const root = workspaceRoot();

	if (root === null) {
		return null;
	}

	const absolute = (file) => (path.isAbsolute(file) ? file : path.join(root, file));

	if (document.languageId !== "php") {
		const blueprint = defineBlueprint(document.getText(), offset);

		return blueprint === null
			? null
			: {
					...blueprint,
					files: [
						{ file: path.join(rootPath("blueprints"), blueprint.target + ".yml"), at: 0 }
					]
				};
	}

	const snippet = define(document.getText(), offset, manifest);

	if (snippet !== null) {
		// A snippet carries its own file, because a plugin can register one that
		// lives nowhere under the snippets root
		const file = manifest.snippets?.[snippet.target]?.file;

		return file === undefined
			? null
			: { ...snippet, files: [{ file: absolute(file), at: 0 }] };
	}

	const key = defineTranslation(document.getText(), offset, manifest);

	if (key === null) {
		return null;
	}

	return {
		...key,
		files: key.targets.map((target) => {
			const file = absolute(target);

			// Read here rather than in the analyser, which stays free of the
			// filesystem so it can be tested as plain functions
			return {
				file,
				at: fs.existsSync(file) === true
					? keyLine(fs.readFileSync(file, "utf8"), key.key)
					: 0
			};
		})
	};
}

const definitions = {
	provideDefinition(document, position) {
		const result = resolveDefinition(document, document.offsetAt(position));

		if (result === null) {
			return;
		}

		// A LocationLink rather than a Location, so the whole path is one link.
		// Without an origin range VS Code falls back to the language's word
		// pattern, and `/` is a word separator, so `components/button` would
		// underline as two separate words with a dead slash between them.
		const origin = new vscode.Range(
			document.positionAt(result.start),
			document.positionAt(result.end)
		);

		return result.files
			.filter(({ file }) => fs.existsSync(file) === true)
			.map(({ file, at }) => {
				const to = at === 0
					? new vscode.Position(0, 0)
					: offsetToPosition(fs.readFileSync(file, "utf8"), at);

				return {
					originSelectionRange: origin,
					targetUri: vscode.Uri.file(file),
					targetRange: new vscode.Range(to, to),
					targetSelectionRange: new vscode.Range(to, to)
				};
			});
	}
};

/**
 * Fixes for our own diagnostics, worked out from the document rather than
 * from the report, so the two can never say different things.
 */
const actions = {
	provideCodeActions(document, range, context) {
		const ours = context.diagnostics.filter((d) => d.source === "kirby-lens");

		if (ours.length === 0) {
			return [];
		}

		const text = document.getText();

		return ours.flatMap((diagnostic) =>
			fixes(text, document.offsetAt(diagnostic.range.start) + 1, manifest).map((fix) => {
				const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);

				action.diagnostics = [diagnostic];
				action.edit = new vscode.WorkspaceEdit();

				// Creating the snippet leaves nothing to edit in this document,
				// and an empty new file is only useful once it is open
				if (fix.create !== undefined) {
					const uri = vscode.Uri.file(
						path.join(rootPath("snippets"), fix.create + ".php")
					);

					action.edit.createFile(uri, { ignoreIfExists: true });
					action.command = { command: "vscode.open", title: "Open", arguments: [uri] };

					return action;
				}

				for (const edit of fix.edits) {
					action.edit.replace(
						document.uri,
						new vscode.Range(
							document.positionAt(edit.start),
							document.positionAt(edit.end)
						),
						edit.text
					);
				}

				return action;
			})
		);
	}
};

/**
 * Renaming a snippet: every call site in the project, and the file itself.
 */
const renames = {
	prepareRename(document, position) {
		const result = define(document.getText(), document.offsetAt(position), manifest);

		if (result === null) {
			throw new Error("Not a snippet name.");
		}

		if (isOwned(result.target) === false) {
			throw new Error(
				`${result.target} is registered by a plugin, so its name lives in that plugin's PHP.`
			);
		}

		return {
			range: new vscode.Range(
				document.positionAt(result.start),
				document.positionAt(result.end)
			),
			placeholder: result.target
		};
	},

	async provideRenameEdits(document, position, name) {
		const result = define(document.getText(), document.offsetAt(position), manifest);
		const root = workspaceRoot();

		if (result === null || root === null || isOwned(result.target) === false) {
			return;
		}

		if (/^[\w-]+(\/[\w-]+)*$/.test(name) === false) {
			throw new Error("A snippet name is made of letters, digits, dashes and slashes.");
		}

		if (snippetFile(name) !== null) {
			throw new Error(`${name} already exists.`);
		}

		const edit = new vscode.WorkspaceEdit();

		for (const uri of await callers()) {
			// The open buffer where there is one, so unsaved calls are renamed too
			const open = vscode.workspace.textDocuments.find(
				(d) => d.uri.toString() === uri.toString()
			);

			const text = open?.getText() ?? Buffer.from(await vscode.workspace.fs.readFile(uri)).toString();

			for (const change of renameEdits(text, result.target, name, manifest)) {
				const positions = open ?? { positionAt: (o) => offsetToPosition(text, o) };

				edit.replace(
					uri,
					new vscode.Range(positions.positionAt(change.start), positions.positionAt(change.end)),
					change.text
				);
			}
		}

		const from = snippetFile(result.target);
		const to = path.join(rootPath("snippets"), name + ".php");

		if (from !== null) {
			edit.renameFile(vscode.Uri.file(from), vscode.Uri.file(to));
		}

		return edit;
	}
};

/**
 * Whether this project owns the file a snippet renders from.
 */
function isOwned(name) {
	const file = snippetFile(name);
	const root = rootPath("snippets");

	return file !== null && root !== null && file.startsWith(root + path.sep);
}

function snippetFile(name) {
	const file = manifest.snippets?.[name]?.file;
	const root = workspaceRoot();

	if (file === undefined || root === null) {
		return null;
	}

	const resolved = path.isAbsolute(file) ? file : path.join(root, file);

	return fs.existsSync(resolved) === true ? resolved : null;
}

/**
 * Every PHP file that could hold a `snippet()` call.
 */
const callers = () =>
	vscode.workspace.findFiles("**/*.php", "{**/vendor/**,**/node_modules/**,**/kirby/**}");

function offsetToPosition(text, offset) {
	const before = text.slice(0, offset).split("\n");

	return new vscode.Position(before.length - 1, before[before.length - 1].length);
}

/**
 * What a translation call resolves to, shown beside it.
 */
const previews = {
	provideInlayHints(document, range) {
		const text = document.getText();
		const from = document.offsetAt(range.start);
		const to = document.offsetAt(range.end);

		return previewTranslations(text, manifest)
			.filter((hint) => hint.offset >= from && hint.offset <= to)
			.map((hint) => {
				const item = new vscode.InlayHint(
					document.positionAt(hint.offset),
					hint.text,
					vscode.InlayHintKind.Parameter
				);

				// paddingLeft does the spacing; a literal space as well reads as
				// an indent rather than a gap
				item.paddingLeft = true;

				return item;
			});
	}
};

// Narrowed to the blueprints root the same way, because the `yaml` selector
// otherwise covers every CI config and lockfile in the workspace
function isBlueprint(document) {
	const root = rootPath("blueprints");

	return (
		root !== null &&
		/\.(yml|yaml)$/.test(document.uri.fsPath) === true &&
		document.uri.fsPath.startsWith(root + path.sep) === true
	);
}

function refreshDiagnostics(document, collection) {
	const blueprint = isBlueprint(document);

	if (document.languageId !== "php" && blueprint === false) {
		return;
	}

	if (config("diagnostics") === false) {
		collection.delete(document.uri);
		return;
	}

	const text = document.getText();
	const root = workspaceRoot();
	const file = root === null ? "" : path.relative(root, document.uri.fsPath);

	const own = ownCode(file, manifest.roots, manifest.packages);

	// Read, never resolved: a cache miss is an unknown type, and an unknown type
	// suppresses nothing, so the cold path and the no-Intelephense path are the
	// same path as the one that ships today
	const resolved = types.get(document.uri.toString()) ?? new Map();

	const problems = (blueprint === true
		? diagnoseBlockLabels(text, manifest, file)
		: [
				...(own === true ? diagnose(text, manifest) : []),
				...(own === true ? diagnoseFields(text, manifest, file) : []),
				...diagnoseTranslations(text, manifest),
				...diagnoseCollections(text, manifest)
			].sort((a, b) => a.start - b.start)
	).filter(
		(problem) =>
			problem.receiver == null ||
			suppresses(resolved.get(problem.receiver.name), manifest, problem.receiver.name) === false
	);

	collection.set(
		document.uri,
		problems.map((problem) => {
			const diagnostic = new vscode.Diagnostic(
				new vscode.Range(
					document.positionAt(problem.start),
					document.positionAt(problem.end)
				),
				problem.message,
				SEVERITIES[problem.severity]
			);

			diagnostic.source = "kirby-lens";
			return diagnostic;
		})
	);
}

/* ------------------------------------------------------------------ */
/* Whole project                                                       */
/* ------------------------------------------------------------------ */

/**
 * Files the last whole-project check published for.
 *
 * Closing a document normally drops its diagnostics, and a document opened by
 * the check is closed by VS Code the moment it stops being referenced. Without
 * this the panel fills and then empties again on its own.
 */
const scanned = new Set();

/**
 * Everything the checks read, as workspace-relative globs. Narrow rather than
 * one recursive glob over the workspace, because that walks `kirby/` and
 * `vendor/`, which is most of a project's files and none of its own code.
 */
function projectGlobs(root) {
	const globs = new Set(["site/**/*.php"]);

	const add = (name, extensions) => {
		const dir = rootPath(name);
		const relative = dir === null ? "" : path.relative(root, dir);

		if (relative !== "" && relative.startsWith("..") === false) {
			globs.add(relative.split(path.sep).join("/") + "/**/*." + extensions);
		}
	};

	for (const name of ["snippets", "templates", "controllers", "models"]) {
		add(name, "php");
	}

	add("blueprints", "{yml,yaml}");

	return [...globs];
}

async function checkProject(collection) {
	const root = workspaceRoot();

	if (root === null || isKirbyProject(root) === false) {
		vscode.window.showWarningMessage("Kirby Lens: no Kirby project in this workspace.");
		return;
	}

	if (config("diagnostics") === false) {
		vscode.window.showWarningMessage(
			"Kirby Lens: diagnostics are turned off. Set kirbyLens.diagnostics to true."
		);
		return;
	}

	const found = new Map();

	for (const glob of projectGlobs(root)) {
		for (const uri of await vscode.workspace.findFiles(glob, "**/vendor/**")) {
			found.set(uri.toString(), uri);
		}
	}

	const files = [...found.values()];

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: "Kirby Lens: checking project",
			cancellable: true
		},
		async (progress, token) => {
			for (const key of scanned) {
				collection.delete(vscode.Uri.parse(key));
			}

			scanned.clear();

			for (const [index, uri] of files.entries()) {
				if (token.isCancellationRequested === true) {
					return;
				}

				progress.report({
					message: `${index + 1}/${files.length}`,
					increment: 100 / files.length
				});

				const document = await vscode.workspace.openTextDocument(uri);

				// Never shown: loading the document is enough for the language
				// server to answer about it, measured against a real host
				refreshDiagnostics(document, collection);
				await refreshTypes(document, collection);

				scanned.add(uri.toString());
			}
		}
	);

	const total = vscode.languages
		.getDiagnostics()
		.flatMap(([, list]) => list)
		.filter((diagnostic) => diagnostic.source === "kirby-lens").length;

	vscode.window.showInformationMessage(
		total === 0
			? `Kirby Lens: no problems in ${files.length} files.`
			: `Kirby Lens: ${total} problem${total === 1 ? "" : "s"} in ${files.length} files.`
	);
}

/* ------------------------------------------------------------------ */

function activate(context) {
	loadManifest();

	const collection = vscode.languages.createDiagnosticCollection("kirby-lens");
	context.subscriptions.push(collection);

	const refreshAll = () => {
		for (const document of vscode.workspace.textDocuments) {
			refreshDiagnostics(document, collection);
			refreshTypes(document, collection);
		}
	};

	// Always, not only when the file is missing: snippets change while the
	// editor is closed, and rebuilding is the only thing that keeps a manifest
	// written by an older version of this extension from being read as current
	regenerate(refreshAll);

	const php = { language: "php", scheme: "file" };
	const yaml = { language: "yaml", scheme: "file" };


	context.subscriptions.push(
		vscode.languages.registerCompletionItemProvider(php, completion, "'", '"', ">"),
		vscode.languages.registerHoverProvider(php, hovers),
		vscode.languages.registerDefinitionProvider(php, definitions),
		vscode.languages.registerDefinitionProvider(yaml, definitions),
		vscode.languages.registerCodeActionsProvider(php, actions, {
			providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
		}),
		vscode.languages.registerRenameProvider(php, renames),
		vscode.languages.registerInlayHintsProvider(php, previews),
		vscode.commands.registerCommand("kirbyLens.checkProject", () => checkProject(collection))
	);

	const file = manifestPath();

	if (file !== null) {
		const watcher = vscode.workspace.createFileSystemWatcher(file);

		const reload = () => {
			loadManifest();
			refreshAll();
		};

		watcher.onDidChange(reload);
		watcher.onDidCreate(reload);
		watcher.onDidDelete(reload);
		context.subscriptions.push(watcher);
	}

	watchSnippets(context, refreshAll);

	// Debounced, because resolving on every keystroke would put a language-server
	// round trip in the typing path. The synchronous publish above never waits
	// for this; it only reads whatever the last answer was.
	let pending = null;
	const laterTypes = (document) => {
		clearTimeout(pending);
		pending = setTimeout(() => refreshTypes(document, collection), 250);
	};

	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument((document) => {
			refreshDiagnostics(document, collection);
			refreshTypes(document, collection);
		}),
		vscode.workspace.onDidChangeTextDocument((event) => {
			refreshDiagnostics(event.document, collection);
			laterTypes(event.document);
		}),
		vscode.workspace.onDidCloseTextDocument((document) => {
			if (scanned.has(document.uri.toString()) === false) {
				collection.delete(document.uri);
			}

			types.delete(document.uri.toString());
		})
	);

	refreshAll();
}

/**
 * Receiver types, per document, as the language server reports them.
 *
 * `$cli->arg()` reads exactly like `$page->headlien()` to a scanner that does
 * not track receivers, and only a type tells them apart. Intelephense already
 * knows, so this asks rather than guessing. Never consulted synchronously
 * without a fallback: an absent answer means the finding stands.
 *
 * @type {Map<string, Map<string, string|null>>}
 */
const types = new Map();

const hasIntelephense = () =>
	vscode.extensions.getExtension("bmewburn.vscode-intelephense-client") !== undefined;

/**
 * The type behind a hover. Intelephense answers in markdown, as
 * ``_@var_ `\Kirby\Cms\Page $page` `` or ``_@param_ `\Kirby\CLI\CLI $cli` ``.
 */
function hoveredType(hovers) {
	for (const hover of hovers ?? []) {
		for (const part of hover.contents ?? []) {
			const declared = /`\s*([^`]*?)\s+\$\w+\s*`/.exec(part?.value ?? String(part ?? ""));

			if (declared !== null) {
				return declared[1].trim();
			}
		}
	}

	return null;
}

/**
 * Resolves the receiver of every finding in a document, one question per
 * variable: a single CLI command file asked the same one about `$cli` 34 times.
 * A clean file costs nothing, because only a finding produces a position.
 */
async function refreshTypes(document, collection) {
	const root = workspaceRoot();

	if (root === null || document.languageId !== "php" || hasIntelephense() === false) {
		return;
	}

	const file = path.relative(root, document.uri.fsPath);

	if (ownCode(file, manifest.roots) === false) {
		return;
	}

	const version = document.version;
	const text = document.getText();
	const found = new Map();

	for (const problem of diagnoseFields(text, manifest, file)) {
		if (problem.receiver == null || found.has(problem.receiver.name) === true) {
			continue;
		}

		const hovers = await vscode.commands.executeCommand(
			"vscode.executeHoverProvider",
			document.uri,
			document.positionAt(problem.receiver.start)
		);

		found.set(problem.receiver.name, hoveredType(hovers));
	}

	// The document moved on while the server was answering, so these answers are
	// about text that no longer exists
	if (document.version !== version) {
		return;
	}

	types.set(document.uri.toString(), found);
	refreshDiagnostics(document, collection);
}

/**
 * Owned here rather than by the dev server so completion stays correct
 * regardless of whether a build watcher happens to be running.
 */
function watchSnippets(context, done) {
	const root = workspaceRoot();

	if (root === null) {
		return;
	}

	let timer = null;

	const debounced = () => {
		clearTimeout(timer);
		timer = setTimeout(() => regenerate(done), 200);
	};

	// Everything the manifest reads that a person edits by hand. A language file
	// gains a key and the diagnostics have to know before the next keystroke.
	// Blueprints are here because a block label is checked against the fieldset's
	// own fields, which only the manifest knows, and they are not PHP.
	const watched = {
		snippets: "**/*.php",
		languages: "**/*.php",
		collections: "**/*.php",
		// Which models can render a file is the two of these together, and the
		// check that reads it arms the moment a model is added
		models: "**/*.php",
		templates: "**/*.php",
		blueprints: "**/*.{yml,yaml}"
	};

	for (const [name, glob] of Object.entries(watched)) {
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(rootPath(name), glob)
		);

		watcher.onDidChange(debounced);
		watcher.onDidCreate(debounced);
		watcher.onDidDelete(debounced);
		context.subscriptions.push(watcher);
	}
}

function deactivate() {}

module.exports = { activate, deactivate };
