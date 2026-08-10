/**
 * `node --check` only validates syntax, so it happily passes a file that calls
 * an undefined function. Both activation paths run here, because the
 * cold-manifest branch never executes when a manifest happens to be present.
 */

const assert = require("node:assert");
const Module = require("node:module");
const path = require("node:path");

const KIRBY = path.join(__dirname, "fixtures");
const ELSEWHERE = __dirname;
const MANIFEST = "site/cache/kirby-lens/manifest.json";
const MISSING = "site/cache/kirby-lens/does-not-exist.json";

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

function activateWith(manifest, { root = KIRBY, fail = null } = {}) {
	const seen = {
		completion: [],
		hover: 0,
		definitions: [],
		actions: [],
		renames: [],
		hints: [],
		watchers: 0,
		command: null,
		warnings: [],
		asked: [],
		commands: 0,
		registered: []
	};
	const noop = () => ({ dispose() {} });

	const vscode = {
		window: {
			showWarningMessage: (message) => seen.warnings.push(message)
		},
		extensions: {
			getExtension: (id) => {
				seen.asked.push(id);
				return undefined;
			}
		},
		commands: {
			executeCommand: async () => {
				seen.commands++;
				return [];
			},
			registerCommand: (id) => {
				seen.registered.push(id);
				return { dispose() {} };
			}
		},
		workspace: {
			workspaceFolders: [{ uri: { fsPath: root } }],
			getConfiguration: () => ({
				get: (key) => ({ manifest, diagnostics: true, php: "php", tags: "near-miss" })[key]
			}),
			// A real document, so activation actually walks the diagnostic and
			// type-resolution paths. An empty list exercises neither, which is
			// how a crash on `vscode.extensions` would have shipped.
			textDocuments: [
				{
					languageId: "php",
					version: 1,
					uri: { fsPath: root + "/site/templates/demo.php", toString: () => "file://demo" },
					getText: () => "<?php echo $page->headlien();",
					positionAt: () => ({ line: 0, character: 0 })
				}
			],
			createFileSystemWatcher: () => {
				seen.watchers++;
				return { onDidChange: noop, onDidCreate: noop, onDidDelete: noop, dispose() {} };
			},
			onDidOpenTextDocument: noop,
			onDidChangeTextDocument: noop,
			onDidCloseTextDocument: noop
		},
		languages: {
			createDiagnosticCollection: () => ({ set() {}, delete() {}, dispose() {} }),
			registerCompletionItemProvider: (selector, provider, ...triggers) => {
				seen.completion.push({
					on: selector.language ?? selector.pattern,
					triggers
				});
				return { dispose() {} };
			},
			registerHoverProvider: () => {
				seen.hover++;
				return { dispose() {} };
			},
			registerDefinitionProvider: (selector) => {
				seen.definitions.push(selector.language);
				return { dispose() {} };
			},
			registerCodeActionsProvider: (selector) => {
				seen.actions.push(selector.language);
				return { dispose() {} };
			},
			registerRenameProvider: (selector) => {
				seen.renames.push(selector.language);
				return { dispose() {} };
			},
			registerInlayHintsProvider: (selector) => {
				seen.hints.push(selector.language);
				return { dispose() {} };
			}
		},
		Range: class {},
		Position: class {},
		RelativePattern: class {},
		InlayHint: class {},
		InlayHintKind: { Parameter: 2 },
		CodeAction: class {},
		CodeActionKind: { QuickFix: 1 },
		WorkspaceEdit: class {
			replace() {}
			renameFile() {}
		},
		CompletionItem: class {
			constructor(label) {
				this.label = label;
			}
		},
		CompletionItemKind: { File: 16, Property: 9, EnumMember: 20 },
		DiagnosticSeverity: { Error: 0, Warning: 1 },
		Hover: class {},
		MarkdownString: class {},
		Diagnostic: class {},
		Location: class {},
		Uri: { file: (p) => ({ fsPath: p }) }
	};

	const childProcess = {
		execFile: (file, args, options, callback) => {
			seen.command = [file, ...args].join(" ");
			callback(fail, "", fail === null ? "" : "boom");
		}
	};

	const load = Module._load;

	Module._load = function (request, ...rest) {
		if (request === "vscode") return vscode;
		if (request === "node:child_process") return childProcess;
		return load.call(this, request, ...rest);
	};

	delete require.cache[require.resolve("../extension.js")];
	const extension = require("../extension.js");

	extension.activate({ subscriptions: { push() {} } });
	extension.deactivate();

	Module._load = load;

	return { extension, seen };
}

check("activates with a manifest present", () => {
	const { seen } = activateWith(MANIFEST);

	assert.deepStrictEqual(seen.completion, [{ on: "php", triggers: ["'", '"', ">"] }]);
	assert.ok(seen.watchers >= 2, `only ${seen.watchers} watcher(s)`);
	assert.strictEqual(seen.hover, 1, "no hover provider registered");

	// Blueprints are YAML, snippet() calls are PHP, and both navigate
	assert.deepStrictEqual(seen.definitions, ["php", "yaml"]);

	// Fixes and renames only make sense where the calls are
	assert.deepStrictEqual(seen.actions, ["php"]);
	assert.deepStrictEqual(seen.renames, ["php"]);
	assert.deepStrictEqual(seen.hints, ["php"]);

	// Rebuilt even though a manifest was already present, because snippets
	// change while the editor is closed
	assert.match(seen.command, /generate\.php/);

	// The type-resolution path is walked, not merely defined. Without a real
	// document in textDocuments it never runs, and a missing `vscode.extensions`
	// would then only surface in someone's editor.
	assert.deepStrictEqual(new Set(seen.asked), new Set(["bmewburn.vscode-intelephense-client"]));
	assert.ok(seen.asked.length > 0, "the type path never ran");

	// Asked, absent, so nothing was resolved and nothing is suppressed
	assert.strictEqual(seen.commands, 0);

	// A command contributed in package.json but never registered is a palette
	// entry that errors when picked
	assert.deepStrictEqual(seen.registered, ["kirbyLens.checkProject"]);
});

check("activates with the manifest missing, and rebuilds it", () => {
	const { seen } = activateWith(MISSING);
	assert.strictEqual(seen.completion.length, 1);

	// The bundled generator, given the project root and where to write
	assert.match(seen.command, /^php \S+\/php\/generate\.php \S+ \S+$/, seen.command);
	assert.deepStrictEqual(seen.warnings, []);
});

check("stays quiet outside a Kirby project", () => {
	const { seen } = activateWith(MISSING, { root: ELSEWHERE });
	assert.strictEqual(seen.command, null, "ran the generator in a non-Kirby workspace");
	assert.deepStrictEqual(seen.warnings, []);
});

check("points at kirbyLens.php when the binary is missing", () => {
	const { seen } = activateWith(MISSING, { fail: Object.assign(new Error("spawn"), { code: "ENOENT" }) });
	assert.strictEqual(seen.warnings.length, 1);
	assert.match(seen.warnings[0], /kirbyLens\.php/);
});

check("surfaces stderr when the generator fails", () => {
	const { seen } = activateWith(MISSING, { fail: Object.assign(new Error("exit 1"), { code: 1 }) });
	assert.strictEqual(seen.warnings.length, 1);
	assert.match(seen.warnings[0], /boom/);
});

check("exports activate and deactivate", () => {
	const { extension } = activateWith(MANIFEST);
	assert.strictEqual(typeof extension.activate, "function");
	assert.strictEqual(typeof extension.deactivate, "function");
});

console.log(`\n${pass} passed`);
