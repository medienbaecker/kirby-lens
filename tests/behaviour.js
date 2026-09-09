const assert = require("node:assert");
const {
	complete, diagnose, hover, define, defineBlueprint,
	diagnoseFields, completeFields, completeFieldMethods,
	defineTranslation, keyLine, diagnoseBlockLabels,
	CONVERSIONS, ROOTS, ownCode, suppresses, fixes, renameEdits,
	diagnoseTranslations, diagnoseCollections, completeTranslations,
	previewTranslations
} = require("../analyze.js");

const snippet = (params, summary = "") => ({ summary, params });

const M = {
	tags: { date: [], image: ["alt", "caption"], link: ["text"] },
	fields: {
		blueprints: {
			"pages/note": { headline: "text", buttons: "structure", hint: "info" },
			site: { logo: "files" }
		},
		union: { headline: "text", intro: "textarea", logo: "files", buttons: "structure", hint: "info", date: "date" }
	},
	methods: ["children", "title", "escape", "esc", "isnotempty", "coverimage", "files", "isempty"],
	fieldMethods: { toStructure: 0, toBlocks: 0, toDate: 2, escape: 1, isNotEmpty: 0 },
	fieldTypes: ["structure", "blocks", "text", "textarea", "files", "date", "info"],
	translations: {
		default: "de",
		resolvable: ["menu.main", "form.first-name", "error.page.notFound"],
		project: { de: ["menu.main", "form.first-name"], fr: ["menu.main"] },
		preview: { "menu.main": "Hauptmenü" },
		files: { de: "site/languages/de.php", fr: "site/languages/fr.php" }
	},
	fieldsets: { card: ["kicker", "headline", "text"] },
	content: {
		"pages/note": { headline: "field", pinned: "field" },
		"pages/panelless": { kicker: "field" },
		site: { hello: "field" }
	},
	collections: ["jobs", "articles"],
	snippets: {
	"components/button": snippet({
		label:   { type: "string|null", description: "", required: false, values: [], scalar: true },
		variant: { type: "'filled'|'outlined'|'text'|null", description: "Style", required: false, values: ["filled","outlined","text"], scalar: true },
		compact: { type: "bool|null", description: "", required: false, values: [], scalar: false },
	}, "Button Component"),
	"components/accordion": snippet({
		title: { type: "string", description: "", required: true, values: [], scalar: true },
		text:  { type: "string|null", description: "", required: false, values: [], scalar: true },
	}),
	"header": snippet({}),
	"blocks/recipes": { ...snippet({}), ignored: true },
	},
	functions: { snippet: false, s: true },
};

let pass = 0, fail = 0;
const check = (n, fn) => { try { fn(); pass++; console.log("  ok   " + n); }
	catch (e) { fail++; console.log("  FAIL " + n + "\n       " + e.message); } };
const labels = r => r.map(x => x.label);
const msgs = r => r.map(x => x.message);

/* completion */

check("completes snippet names", () => {
	assert.deepStrictEqual(labels(complete(`<?php snippet('`, M)),
		["components/accordion", "components/button", "header"]);
});

check("an ignored snippet is never offered", () => {
	assert.ok(labels(complete(`<?php snippet('`, M)).includes("blocks/recipes") === false);
});

check("completes keys", () => {
	assert.deepStrictEqual(labels(complete(`<?php snippet('components/button', ['`, M)),
		["label", "variant", "compact"]);
});

check("omits keys already used in the same call", () => {
	assert.deepStrictEqual(labels(complete(`<?php snippet('components/button', ['label' => 'x', '`, M)),
		["variant", "compact"]);
});

check("keys used in a DIFFERENT call are still offered", () => {
	const src = `<?php snippet('components/button', ['label' => 'a']); snippet('components/button', ['`;
	assert.ok(labels(complete(src, M)).includes("label"));
});

check("marks required keys", () => {
	const r = complete(`<?php snippet('components/accordion', ['`, M);
	assert.strictEqual(r.find(x => x.label === "title").detail, "string (required)");
});

check("completes literal values", () => {
	assert.deepStrictEqual(labels(complete(`<?php snippet('components/button', ['variant' => '`, M)),
		["filled", "outlined", "text"]);
});

check("no values for a free-form key", () => {
	assert.deepStrictEqual(complete(`<?php snippet('components/button', ['label' => '`, M), []);
});

check("nothing outside a snippet call", () => {
	assert.deepStrictEqual(complete(`<?php $x = '`, M), []);
	assert.deepStrictEqual(complete(`<?php snippet('components/button', ['variant' => 'filled']);`, M), []);
});

check("unknown snippet yields nothing", () => {
	assert.deepStrictEqual(complete(`<?php snippet('nope/nope', ['`, M), []);
});

// Everything below passes a whole document and an explicit cursor, which is how
// the editor calls it. Completing only what is still being typed would mean a
// name or key could never be changed once written.

const at = (source, caret) => [source.replace("|", ""), source.indexOf("|")];
const only = (r, label) => r.find((x) => x.label === label);

check("completes over a name already written", () => {
	const [text, caret] = at(`<?php snippet('compo|nents/button');`);
	const r = complete(text, M, caret);

	assert.ok(labels(r).includes("components/button"));

	// The quotes are part of what gets replaced, so the whole literal is rewritten
	assert.strictEqual(
		text.slice(only(r, "header").replace.start, only(r, "header").replace.end),
		"'components/button'"
	);
	assert.strictEqual(only(r, "header").insert, "'header'");
});

check("completes over a key already written", () => {
	const [text, caret] = at(`<?php snippet('components/button', ['lab|']);`);
	assert.ok(labels(complete(text, M, caret)).includes("label"));
});

check("a key writes its own arrow, and quotes when the values are known", () => {
	const [text, caret] = at(`<?php snippet('components/button', ['v|']);`);
	const r = complete(text, M, caret);

	assert.strictEqual(only(r, "variant").insert, "'variant' => '$0'");
	assert.strictEqual(only(r, "variant").retrigger, true);

	// label is free-form, so quoting it would presume a string
	assert.strictEqual(only(r, "label").insert, "'label' => $0");
	assert.strictEqual(only(r, "label").retrigger, false);
});

check("a key that already has a value does not write a second arrow", () => {
	const [text, caret] = at(`<?php snippet('components/button', ['v|' => 'filled']);`);
	const r = complete(text, M, caret);

	assert.strictEqual(only(r, "variant").insert, "'variant'");
	assert.strictEqual(only(r, "variant").retrigger, false);
});

check("keeps the quoting style the call already uses", () => {
	const [text, caret] = at(`<?php snippet("components/button", ["v|"]);`);
	assert.strictEqual(only(complete(text, M, caret), "variant").insert, '"variant" => "$0"');
});

// An unterminated quote pairs with the next one anywhere in the file, so the
// literal the scanner reports can span the rest of the document. VS Code drops
// every item whose range covers more than one line, which reads as the
// extension having stopped working.
check("never overwrites past the line being typed on", () => {
	const text =
		"<?php\n" +
		"snippet('components/\n" +
		"\n" +
		"<div class='hero'>\n" +
		"<p>more</p>\n";

	const caret = text.indexOf("components/") + "components/".length;
	const r = complete(text, M, caret);

	assert.ok(r.length > 0, "nothing offered at all");

	for (const item of r) {
		const covered = text.slice(item.replace.start, item.replace.end);

		assert.ok(covered.includes("\n") === false, `range spans lines: ${JSON.stringify(covered)}`);
		assert.strictEqual(covered, "'components/");
	}
});

// Setting a range makes VS Code filter on the text that range covers rather
// than on the word at the cursor. Ours starts at the opening quote, so a label
// alone matches nothing and the list comes up empty with no error anywhere.
// executeCompletionItemProvider returns raw provider output and never filters,
// so no editor test can catch this. Only this one does.
check("what the editor filters on always matches what it would replace", () => {
	const cases = [
		`<?php snippet('comp|`,
		`<?php snippet('comp|onents/button');`,
		`<?php snippet("comp|onents/button");`,
		`<?php snippet('components/button', ['va|`,
		`<?php snippet('components/button', ['va|riant' => 'filled']);`,
		`<?php snippet('components/button', ['variant' => 'fil|`,
		`<?php snippet('components/button', ['variant' => 'fil|led']);`,
		`<?= s('comp|`,
		`<?= s('o:comp|onents/button') ?>`,
		`<?= s('components/button', va|`,
		`<?= s('components/button', va|riant: 'filled') ?>`,
		`<?= s('components/button', variant: 'fil|`
	];

	for (const source of cases) {
		const [text, caret] = at(source);
		const r = complete(text, M, caret);

		assert.ok(r.length > 0, `nothing offered for ${source}`);

		const covered = text.slice(r[0].replace.start, r[0].replace.end);
		const quote = /['"]/.test(covered[0]) === true ? covered[0] : "";

		// Every item has to carry the quote, or the editor cannot match one
		for (const item of r) {
			assert.ok(
				item.filter !== undefined && item.filter.startsWith(quote),
				`${source}: editor would filter "${covered}" against "${item.filter}"`
			);
		}

		// And what has been typed has to actually reach something. Fuzzy
		// matching drops the rest, which is the point of typing it.
		assert.ok(
			r.some((item) => item.filter.startsWith(covered)),
			`${source}: nothing in the list matches "${covered}"`
		);
	}
});

check("a literal opening on an earlier line is not a name being typed", () => {
	const text = "<?php snippet('one\ntwo');";

	assert.deepStrictEqual(complete(text, M, text.indexOf("two") + 1), []);
});

check("a cursor outside the quotes completes nothing", () => {
	const [text, caret] = at(`<?php snippet('components/button')|;`);
	assert.deepStrictEqual(complete(text, M, caret), []);
});

/* quick fixes and rename */

// A fix is derived from the document, never from the wording of the report, so
// the two cannot drift apart. Each one is anchored where the report is.
const fix = (source, manifest = M) => {
	const [text, caret] = at(source);
	return fixes(text, caret, manifest);
};

const applied = (source, index = 0, manifest = M) => {
	const [text, caret] = at(source);
	const chosen = fixes(text, caret, manifest)[index];

	return chosen === undefined
		? null
		: chosen.edits.reduce(
				(out, edit) => out.slice(0, edit.start) + edit.text + out.slice(edit.end),
				text
			);
};

check("offers to create a snippet that does not exist", () => {
	assert.deepStrictEqual(fix(`<?php snippet('me|ow');`),
		[{ title: "Create snippet 'meow'", create: "meow" }]);
});

// `$cli->success()` is reported only because nothing says what `$cli` is. The
// type hint is what the surrounding code already uses, 76 times against 2, and
// once it is there Intelephense resolves the receiver and the finding goes.
check("types the closure a CLI command was registered with", () => {
	assert.strictEqual(
		applied(`<?php return ['commands' => ['x' => ['command' => function ($cli) { $cli->suc|cess('ok'); }]]];`),
		`<?php return ['commands' => ['x' => ['command' => function (\\Kirby\\CLI\\CLI $cli) { $cli->success('ok'); }]]];`
	);
});

check("offers no type it cannot name", () => {
	// Already typed, so there is nothing to add
	assert.deepStrictEqual(fix(`<?php ['command' => function (\\Kirby\\CLI\\CLI $cli) { $cli->suc|cess(); }];`), []);
	// Not a key whose callback signature is known
	assert.deepStrictEqual(fix(`<?php ['action' => function ($cli) { $cli->suc|cess(); }];`), []);
	// A model receiver: documenting it would not silence its own diagnostic
	assert.deepStrictEqual(fix(`<?php echo $page->head|lien();`), []);
});

// mask() blanks every string, so a signature quoted inside one is not a signature
check("a closure written inside a string is not one", () => {
	assert.deepStrictEqual(fix(`<?php $x = "'command' => function ($cli)"; $cli->suc|cess();`), []);
});

check("offers the name that was probably meant before offering to create one", () => {
	assert.deepStrictEqual(fix(`<?php snippet('hea|de');`).map((f) => f.title),
		["Change to 'header'", "Create snippet 'heade'"]);

	assert.strictEqual(applied(`<?php snippet('hea|de');`), `<?php snippet('header');`);
});

check("an ignored snippet is still worth suggesting", () => {
	assert.deepStrictEqual(fix(`<?php snippet('blocks/re|cipe');`).map((f) => f.title),
		["Change to 'blocks/recipes'", "Create snippet 'blocks/recipe'"]);
});

check("refuses to create a name that could climb out of the snippets root", () => {
	assert.deepStrictEqual(fix(`<?php snippet('..|/../etc/passwd');`), []);
});

check("a snippet that exists is never offered for creation", () => {
	assert.deepStrictEqual(fix(`<?php snippet('hea|der');`), []);
	assert.deepStrictEqual(fix(`<?php snippet('blocks/re|cipes');`), []);
});

check("offers the value that was probably meant, best guess first", () => {
	const r = fix(`<?php snippet('components/button', ['variant' => '|otulined']);`);

	assert.deepStrictEqual(
		r.map((f) => f.title),
		["Change to 'outlined'", "Change to 'filled'", "Change to 'text'"]
	);

	assert.strictEqual(
		applied(`<?php snippet('components/button', ['variant' => '|otulined']);`),
		`<?php snippet('components/button', ['variant' => 'outlined']);`
	);
});

check("offers every allowed value even when nothing is close", () => {
	const r = fix(`<?php snippet('components/button', ['variant' => '|zzzzzzzz']);`);

	assert.deepStrictEqual(r.map((f) => f.title), [
		"Change to 'filled'",
		"Change to 'outlined'",
		"Change to 'text'"
	]);
});

check("offers the parameter a misspelled key was probably meant to be", () => {
	assert.strictEqual(
		applied(`<?php snippet('components/button', ['|varaint' => 'filled']);`),
		`<?php snippet('components/button', ['variant' => 'filled']);`
	);
});

check("a key nothing resembles is left alone", () => {
	assert.deepStrictEqual(fix(`<?php snippet('components/button', ['|zzzzzzzzzz' => 'x']);`), []);
});

check("adds the required parameters a call is missing", () => {
	assert.strictEqual(
		applied(`<?php snippet('components/|accordion', ['text' => 'x']);`),
		`<?php snippet('components/accordion', ['text' => 'x', 'title' => '']);`
	);
});

check("nothing to fix where nothing was reported", () => {
	assert.deepStrictEqual(fix(`<?php snippet('components/button', ['variant' => '|filled']);`), []);
	assert.deepStrictEqual(fix(`<?php snippet('|components/button');`), []);
});

check("renames every spelling of a name in a file, and nothing else", () => {
	const text =
		"<?php\n" +
		"snippet('components/button');\n" +
		"snippet(['components/button', 'fallback']);\n" +
		"snippet('components/button-group');\n" +
		"$x = 'components/button';\n";

	const edits = renameEdits(text, "components/button", "ui/button");

	assert.strictEqual(edits.length, 2);
	assert.deepStrictEqual(
		edits.map((e) => text.slice(e.start, e.end)),
		["components/button", "components/button"]
	);

	// The quotes are never part of the edit, so the name swaps inside them
	const after = edits
		.slice()
		.reverse()
		.reduce((out, e) => out.slice(0, e.start) + e.text + out.slice(e.end), text);

	assert.ok(after.includes("snippet('ui/button');"));
	assert.ok(after.includes("snippet(['ui/button', 'fallback']);"));
	assert.ok(after.includes("snippet('components/button-group');"), "renamed a longer name");
	assert.ok(after.includes("$x = 'components/button';"), "renamed a string outside a call");
});

/* translations and collections */

// A miss is not an error in Kirby: t() returns null, so the page renders with a
// hole in it, in every environment including debug.
check("flags a key that resolves nowhere, and names what was meant", () => {
	const r = diagnoseTranslations("<?php echo t('form.first_name');", M);

	assert.strictEqual(r.length, 1);
	assert.match(r[0].message, /form\.first_name/);
	assert.match(r[0].message, /Did you mean "form\.first-name"\?/);
});

check("Kirby's own keys resolve, so they are never flagged", () => {
	assert.deepStrictEqual(diagnoseTranslations("<?php t('error.page.notFound');", M), []);
});

// The rule differs by function. I18n::translate returns any non-null fallback
// before it ever reaches the fallback locales; I18n::template moves an array
// one into $replace first, so there it is not a fallback at all.
check("a fallback makes an unknown key deliberate, per function", () => {
	const flagged = (src) => diagnoseTranslations(`<?php ${src}`, M).length;

	assert.strictEqual(flagged("t('nope', 'Hello');"), 0, "string fallback to t");
	assert.strictEqual(flagged("t('nope', ['en' => 'Hi']);"), 0, "array fallback to t");
	assert.strictEqual(flagged("t('nope', $x);"), 0, "a variable could be a string");
	assert.strictEqual(flagged("tt('nope', 'Hello');"), 0, "string fallback to tt");
	assert.strictEqual(flagged("tt('nope', ['url' => $x]);"), 1, "an array to tt is $replace");
	assert.strictEqual(flagged("t('nope', null);"), 1, "null is not a fallback");
});

check("only a plain string literal is ever a key", () => {
	const flagged = (src) => diagnoseTranslations(`<?php ${src}`, M).length;

	assert.strictEqual(flagged("t(['en' => 'Hi', 'de' => 'Hallo']);"), 0, "array key");
	assert.strictEqual(flagged("t('job.' . $x);"), 0, "concatenation");
	assert.strictEqual(flagged("t($key);"), 0, "variable");
	assert.strictEqual(flagged('t("nope $x");'), 0, "interpolated");
	assert.strictEqual(flagged("// t('nope');"), 0, "comment");
});

check("the static forms are the same call", () => {
	assert.strictEqual(diagnoseTranslations("<?php I18n::translate('nope');", M).length, 1);
	assert.strictEqual(diagnoseTranslations("<?php I18n::template('nope');", M).length, 1);
});

// collection() throws rather than rendering empty, so this one is an error
check("flags a collection that resolves nowhere", () => {
	const r = diagnoseCollections("<?php collection('jbs');", M);

	assert.strictEqual(r.length, 1);
	assert.strictEqual(r[0].severity, "error");
	assert.match(r[0].message, /Did you mean "jobs"\?/);
});

check("a collection that exists, or a computed name, is left alone", () => {
	assert.deepStrictEqual(diagnoseCollections("<?php collection('jobs');", M), []);
	assert.deepStrictEqual(diagnoseCollections("<?php collection($name);", M), []);
	assert.deepStrictEqual(diagnoseCollections("<?php $this->collection('jbs');", M), []);
});

check("shows what a resolvable call actually says", () => {
	const text = "<?php echo t('menu.main');";
	const r = previewTranslations(text, M);

	assert.deepStrictEqual(r, [{ offset: text.indexOf("')") + 1, text: "Hauptmenü" }]);
});

check("says nothing where there is nothing to say", () => {
	// Kirby's own Panel strings are not in the preview set, and a key that
	// resolves nowhere has no text to show either
	assert.deepStrictEqual(previewTranslations("<?php t('error.page.notFound');", M), []);
	assert.deepStrictEqual(previewTranslations("<?php t('form.first-name');", M), []);
	assert.deepStrictEqual(previewTranslations("<?php t($key);", M), []);
	assert.deepStrictEqual(previewTranslations("<?php t('menu.main');", {}), []);
});

check("completes a translation key, quotes carried into the filter", () => {
	const [text, caret] = at("<?php t('menu|')");
	const r = completeTranslations(text, M, caret);

	assert.ok(r.some((i) => i.label === "menu.main"));

	for (const item of r) {
		assert.ok(item.filter.startsWith("'"), "filter must carry the quote");
		assert.strictEqual(text.slice(item.replace.start, item.replace.end), "'menu'");
	}
});

/* diagnostics */

check("flags a value outside the set, listing valid ones", () => {
	const r = diagnose(`<?php snippet('components/button', ['variant' => 'otulined']);`, M);
	assert.strictEqual(r.length, 1);
	assert.match(r[0].message, /not a valid variant. Expected: filled, outlined, text/);
	assert.strictEqual(r[0].severity, "error");
});

check("accepts a valid value", () => {
	assert.deepStrictEqual(diagnose(`<?php snippet('components/button', ['variant' => 'text']);`, M), []);
});

check("flags a string where the type forbids one", () => {
	const r = diagnose(`<?php snippet('components/button', ['compact' => 'yes']);`, M);
	assert.match(r[0].message, /compact expects bool\|null, not a string/);
});

check("flags an undocumented key", () => {
	const r = diagnose(`<?php snippet('components/button', ['varaint' => 'x']);`, M);
	assert.match(r[0].message, /"varaint" is not a documented parameter/);
	assert.strictEqual(r[0].severity, "warning");
});

check("flags a missing required key", () => {
	const r = diagnose(`<?php snippet('components/accordion', ['text' => 'x']);`, M);
	assert.match(r[0].message, /missing required: title/);
});

check("does not flag missing required when no literal keys are passed", () => {
	assert.deepStrictEqual(diagnose(`<?php snippet('components/accordion', $data);`, M), []);
});

check("ignores an undocumented snippet entirely", () => {
	assert.deepStrictEqual(diagnose(`<?php snippet('header', ['class' => 'x']);`, M), []);
});

// Suppressing on a positive non-model answer can never kill a true finding:
// measured across the corpus, no real one resolves to a concrete non-model class
const TYPED = { models: ["Kirby\\Cms\\Page", "Kirby\\Cms\\StructureObject", "defaultPage"] };

check("a concrete class that is no kind of model rules a finding out", () => {
	assert.strictEqual(suppresses("\\Kirby\\CLI\\CLI", TYPED), true);
	assert.strictEqual(suppresses("\\Kirby\\Http\\Request", TYPED), true);
});

check("a model, however it is spelled, does not", () => {
	assert.strictEqual(suppresses("\\Kirby\\Cms\\StructureObject", TYPED), false);
	assert.strictEqual(suppresses("Kirby\\Cms\\Page", TYPED), false);
	assert.strictEqual(suppresses("defaultPage", TYPED), false);
});

check("an unresolved receiver says nothing either way", () => {
	// `$this` is what Intelephense answers for a fluent method, and a scalar is
	// not a class at all. Suppressing on any of these would be guessing.
	// `unset` is real: it is what the server answered at `$page->title()->vaue()`,
	// and treating it as a class suppressed a genuine typo until the corpus said so
	for (const type of ["mixed", "object", "$this", "static", "void", "never", "string", "bool", "array", "unset", "", null, undefined]) {
		assert.strictEqual(suppresses(type, TYPED), false, `suppressed on ${type}`);
	}
});

check("a nullable or repeated model is still a model", () => {
	assert.strictEqual(suppresses("?\\Kirby\\Cms\\Page", TYPED), false);
	assert.strictEqual(suppresses("\\Kirby\\Cms\\Page[]", TYPED), false);
});

check("a union rules out only when no alternative is a model", () => {
	assert.strictEqual(suppresses("\\Kirby\\Form\\Field|\\Kirby\\Form\\FieldClass", TYPED), true);
	assert.strictEqual(suppresses("\\Kirby\\CLI\\CLI|\\Kirby\\Cms\\Page", TYPED), false);
	assert.strictEqual(suppresses("\\Kirby\\Cms\\Page|null", TYPED), false);
});

// Kirby puts these in scope itself, so no answer about one is worth acting on.
// This is what kept `$page->title()->vaue()` reported when the server replied
// `unset` about `$page`. Measured: guarding them costs 0 of 327 suppressions.
check("a receiver Kirby injects is never ruled out", () => {
	for (const name of ["$page", "$site", "$kirby", "$file", "$user"]) {
		assert.strictEqual(suppresses("\\Kirby\\CLI\\CLI", TYPED, name), false, name);
	}

	assert.strictEqual(suppresses("\\Kirby\\CLI\\CLI", TYPED, "$cli"), true);
});

check("a manifest with no model list suppresses nothing", () => {
	assert.strictEqual(suppresses("\\Kirby\\CLI\\CLI", {}), false);
});

check("a finding carries the receiver a caller would resolve", () => {
	const r = diagnoseFields("<?php echo $page->headlien();", M);
	assert.strictEqual(r[0].receiver.name, "$page");
});

check("the field and snippet checks answer in the project's own code", () => {
	assert.strictEqual(ownCode("site/templates/note.php"), true);
	assert.strictEqual(ownCode("site/snippets/components/button.php"), true);
	assert.strictEqual(ownCode("site/controllers/note.php"), true);
	assert.strictEqual(ownCode("site/models/note.php"), true);
});

check("and in a plugin the project wrote for itself", () => {
	assert.strictEqual(ownCode("site/plugins/site/index.php"), true);
	assert.strictEqual(ownCode("site/plugins/helpers/index.php"), true);
});

// A package is the one clear case where the author cannot fix what is reported,
// and a `composer.json` is what tells one from a plugin written for the project
check("but never inside a vendored package", () => {
	const packages = ["site/plugins/kirby-alter", "site/plugins/kirby-tiptap"];

	assert.strictEqual(ownCode("site/plugins/kirby-alter/commands/generate.php", undefined, packages), false);
	assert.strictEqual(ownCode("site/plugins/site/index.php", undefined, packages), true);
});

check("and not outside the project's code at all", () => {
	assert.strictEqual(ownCode("site/blueprints/pages/note.yml"), false);
	assert.strictEqual(ownCode("index.php"), false);
});

check("a configured root takes the scope with it", () => {
	const roots = { templates: "app/templates" };

	assert.strictEqual(ownCode("app/templates/note.php", roots), true);
	assert.strictEqual(ownCode("site/templates/note.php", roots), false);
});

check("an unknown snippet is reported once, and its keys are still not checked", () => {
	assert.deepStrictEqual(msgs(diagnose(`<?php snippet('nope', ['variant' => 'otulined']);`, M)),
		['Snippet "nope" not found.']);
});

check("an ignored snippet is not a missing one", () => {
	assert.deepStrictEqual(diagnose(`<?php snippet('blocks/recipes');`, M), []);
});

check("names the snippet that was probably meant", () => {
	assert.deepStrictEqual(msgs(diagnose(`<?php snippet('heade');`, M)),
		['Snippet "heade" not found. Did you mean "header"?']);
});

check("a name still being typed is not reported", () => {
	assert.deepStrictEqual(diagnose(`<?php snippet('meo`, M), []);
});

check("a name that is an expression is not reported", () => {
	assert.deepStrictEqual(diagnose(`<?php snippet('tiptap/' . $x); snippet($y, ['a' => 'b']);`, M), []);
});

check("says nothing when the manifest carries no snippets", () => {
	assert.deepStrictEqual(diagnose(`<?php snippet('meow');`, { snippets: {} }), []);
});

check("never flags an example inside a comment", () => {
	const src = `<?php
/**
 * snippet('components/button', ['variant' => 'nonsense']);
 */
snippet('components/button', ['variant' => 'text']);`;
	assert.deepStrictEqual(diagnose(src, M), []);
});

check("diagnostics are ordered by position", () => {
	const r = diagnose(`<?php snippet('components/button', ['variant' => 'zzz', 'compact' => 'yes']);`, M);
	assert.strictEqual(r.length, 2);
	assert.ok(r[0].start < r[1].start);
});

/* hover */

check("hover on a snippet name lists its parameters", () => {
	const src = `<?php snippet('components/button', []);`;
	const h = hover(src, src.indexOf("components/button") + 2, M);
	assert.match(h.contents, /components\/button/);
	assert.match(h.contents, /\*\*variant\*\*/);
});

check("hover on a key shows type and description", () => {
	const src = `<?php snippet('components/button', ['variant' => 'text']);`;
	const h = hover(src, src.indexOf("'variant'") + 2, M);

	// The null is dropped: optional is conveyed by not being marked required
	assert.match(h.contents, /'filled' \| 'outlined' \| 'text'/);
	assert.doesNotMatch(h.contents, /null/);
	assert.match(h.contents, /Style/);

	// For a literal union the type already is the list of allowed values
	assert.doesNotMatch(h.contents, /Allowed/);
});

check("hover on a snippet name leads with the summary", () => {
	const src = `<?php snippet('components/button');`;
	const h = hover(src, src.indexOf("components/button") + 4, M);
	assert.match(h.contents, /\*\*components\/button\*\*\n\nButton Component/);
});

check("hover groups required before optional", () => {
	const src = `<?php snippet('components/accordion');`;
	const h = hover(src, src.indexOf("components/accordion") + 4, M);
	assert.ok(h.contents.indexOf("**Required**") < h.contents.indexOf("**Optional**"));
	assert.ok(h.contents.indexOf("**title**") < h.contents.indexOf("**text**"));
});

check("a snippet with no parameters says so", () => {
	const src = `<?php snippet('header');`;
	const h = hover(src, src.indexOf("header") + 2, M);
	assert.match(h.contents, /No parameters/);
});

check("hover elsewhere is null", () => {
	assert.strictEqual(hover(`<?php $x = 1;`, 8, M), null);
});

/* ------------------------------------------------------------------ */
/* Go to definition                                                    */
/* ------------------------------------------------------------------ */

const CALL = `<?php snippet('components/button', ['label' => 'x']); snippet('gone');`;

check("resolves a snippet name", () => {
	const at = define(CALL, CALL.indexOf("components/button") + 4, M);
	assert.strictEqual(at.target, "components/button");
	assert.strictEqual(CALL.slice(at.start, at.end), "components/button");
});

check("offers nothing for a snippet that does not exist", () => {
	assert.strictEqual(define(CALL, CALL.indexOf("gone") + 1, M), null);
});

check("an ignored snippet is still a definition", () => {
	const text = `<?php snippet('blocks/recipes');`;
	assert.strictEqual(define(text, text.indexOf("blocks/recipes") + 1, M).target, "blocks/recipes");
});

check("a key is not a definition", () => {
	assert.strictEqual(define(CALL, CALL.indexOf("label") + 1, M), null);
});

const KEY = `<?php echo t('menu.main') . t('error.page.notFound') . t($x) . t('form.first-name');`;

check("a translation key resolves to every language file that defines it", () => {
	const at = defineTranslation(KEY, KEY.indexOf("menu.main") + 1, M);

	// de first because it is the default, then the rest alphabetically
	assert.deepStrictEqual(at.targets, ["site/languages/de.php", "site/languages/fr.php"]);
	assert.strictEqual(KEY.slice(at.start, at.end), "menu.main");
});

check("only the languages that actually define it", () => {
	assert.deepStrictEqual(
		defineTranslation(KEY, KEY.indexOf("form.first-name") + 1, M).targets,
		["site/languages/de.php"]
	);
});

// Kirby's merge keeps no record of which file wrote a value, so a core key has
// no honest target. A link into an arbitrary one would be worse than none.
check("a key the project does not define offers nothing", () => {
	assert.strictEqual(defineTranslation(KEY, KEY.indexOf("error.page") + 1, M), null);
});

check("a computed key offers nothing", () => {
	assert.strictEqual(defineTranslation(KEY, KEY.indexOf("$x") + 1, M), null);
});

const LANG = [
	"<?php",
	"return [",
	"    'code' => 'de',",
	"    'translations' => [",
	"        'menu.main' => 'Hauptmenü',",
	"        'note' => 'menu.main'",
	"    ]",
	"];"
].join("\n");

check("finds the line a language file writes a key on", () => {
	assert.strictEqual(LANG.slice(keyLine(LANG, "menu.main")).startsWith("menu.main'"), true);

	// The one on the value side reads the same and is not the definition
	assert.strictEqual(LANG.slice(0, keyLine(LANG, "menu.main")).includes("'note'"), false);
});

check("a key the file does not have opens it at the top", () => {
	assert.strictEqual(keyLine(LANG, "nope"), 0);
});

/* ------------------------------------------------------------------ */
/* Block labels                                                        */
/* ------------------------------------------------------------------ */

const BLOCK = "site/blueprints/blocks/card.yml";

check("reports a block label naming a field the block does not have", () => {
	const r = diagnoseBlockLabels(`name: Card\nlabel: "{{ title }}"\n`, M, BLOCK);

	assert.strictEqual(r.length, 1);
	assert.match(r[0].message, /Field "title" not found in this block/);
});

check("says nothing about a field the block does have", () => {
	assert.deepStrictEqual(diagnoseBlockLabels(`label: "{{ kicker }}"\n`, M, BLOCK), []);
});

// The Panel's own pattern is `[{]{1,2}[\s]?(.*?)[\s]?[}]{1,2}`, so one brace
// and a missing space both resolve, and a checker that insists on `{{ x }}`
// would quietly pass over a real one
check("matches the brace and spacing forms the Panel accepts", () => {
	assert.strictEqual(diagnoseBlockLabels(`label: "H{{ title}}"\n`, M, BLOCK).length, 1);
	assert.strictEqual(diagnoseBlockLabels(`label: "{ title }"\n`, M, BLOCK).length, 1);
	assert.deepStrictEqual(diagnoseBlockLabels(`label: "{{kicker}}"\n`, M, BLOCK), []);
});

// A block label is resolved against the block's own content, so only the first
// segment is a field of it; the rest is property access into that value
check("only the first segment is a field", () => {
	assert.deepStrictEqual(diagnoseBlockLabels(`label: "{{ kicker.length }}"\n`, M, BLOCK), []);
});

// A label nested under a field is that field's own label, and a server-side
// query against the model rather than a lookup into the block
check("a nested label is not a block label", () => {
	assert.deepStrictEqual(
		diagnoseBlockLabels(`fields:\n  x:\n    label: "{{ title }}"\n`, M, BLOCK),
		[]
	);
});

check("reports the offset of the name, not of the braces", () => {
	const text = `label: "{{ title }}"\n`;
	const r = diagnoseBlockLabels(text, M, BLOCK);

	assert.strictEqual(text.slice(r[0].start, r[0].end), "title");
});

check("a blueprint that is not a fieldset is not checked", () => {
	for (const file of [
		"site/blueprints/pages/note.yml",
		"site/blueprints/sections/cards.yml",
		"site/snippets/blocks/card.php"
	]) {
		assert.deepStrictEqual(diagnoseBlockLabels(`label: "{{ title }}"\n`, M, file), [], file);
	}
});

check("a fieldset the manifest never saw is not checked", () => {
	assert.deepStrictEqual(
		diagnoseBlockLabels(`label: "{{ title }}"\n`, M, "site/blueprints/blocks/unknown.yml"),
		[]
	);
});

/* ------------------------------------------------------------------ */
/* Blueprint queries                                                   */
/* ------------------------------------------------------------------ */

const PAGE = "site/blueprints/pages/note.yml";

const YAML = [
	"fields:",
	"  hero:",
	"    extends: fields/headline",
	"  body:",
	"    type: blocks",
	"    fieldsets: [text, custom/thing]",
	"  more:",
	"    fieldsets:",
	"      - quote",
	"    label: not a reference",
].join("\n");

const target = (needle) => defineBlueprint(YAML, YAML.indexOf(needle) + 1);

check("resolves extends", () => {
	assert.strictEqual(target("fields/headline").target, "fields/headline");
});

// fieldsets resolve through the same mixin mechanism without the word extends,
// so searching for `extends:` alone misses this whole class
check("resolves an inline fieldsets entry", () => {
	assert.strictEqual(target("custom/thing").target, "custom/thing");
});

check("resolves a block fieldsets entry", () => {
	assert.strictEqual(target("quote").target, "quote");
});

check("blueprint offsets are exact", () => {
	for (const name of ["fields/headline", "text", "custom/thing", "quote"]) {
		const at = target(name);
		assert.strictEqual(YAML.slice(at.start, at.end), name, name);
	}
});

check("an ordinary value is not a reference", () => {
	assert.strictEqual(defineBlueprint(YAML, YAML.indexOf("not a reference") + 2), null);
	assert.strictEqual(defineBlueprint(YAML, YAML.indexOf("type: blocks") + 8), null);
});

/* ------------------------------------------------------------------ */
/* KirbyTags                                                           */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Blueprint fields                                                    */
/* ------------------------------------------------------------------ */

const named = (r) => r.map((p) => p.message.match(/"([^"]+)"/)[1]);

check("flags a name in no blueprint and no method list", () => {
	const r = diagnoseFields("<?php echo $page->headlien();", M);
	assert.deepStrictEqual(named(r), ["headlien"]);
	assert.strictEqual(r[0].severity, "warning");
});

check("accepts a field from any blueprint", () => {
	assert.deepStrictEqual(diagnoseFields("<?php echo $page->intro();", M), []);
});

// A structure's sub-fields are reachable on a structure item and nowhere else,
// so they answer the check without ever joining a completion list
check("accepts a structure sub-field", () => {
	assert.deepStrictEqual(named(diagnoseFields("<?php echo $pin->pin_x();", M)), ["pin_x"]);
	assert.deepStrictEqual(
		diagnoseFields("<?php echo $pin->pin_x();", { ...M, structures: { pin_x: "field" } }),
		[]
	);
});

check("but never offers one after a receiver", () => {
	const m = { ...M, structures: { pin_x: "field" } };
	const offered = labels(completeFields("<?php echo $page->", m, "site/templates/note.php"));

	assert.ok(offered.includes("pin_x") === false, `offered ${offered}`);
});

check("accepts a real Kirby method", () => {
	assert.deepStrictEqual(diagnoseFields("<?php echo $page->children();", M), []);
});

/* ------------------------------------------------------------------ */
/* Page model methods                                                  */
/* ------------------------------------------------------------------ */

// An article page has no template of its own, so it renders default.php and
// reaches every snippet that does. FormPage is a package's, and headline is a
// field as well as a method.
const SCOPED = {
	...M,
	packages: ["site/plugins/kirby-dreamform"],
	pageModels: {
		DefaultPage: {
			name: "DefaultPage",
			file: "site/models/default.php",
			methods: ["seotitle", "coverimage", "headline"]
		},
		ArticlePage: { name: "ArticlePage", file: "site/models/article.php", methods: [] },
		FormPage: {
			name: "FormPage",
			file: "site/plugins/kirby-dreamform/models/FormPage.php",
			methods: ["coverimage"]
		}
	},
	renders: {
		"site/templates/default.php": ["ArticlePage", "DefaultPage"],
		"site/snippets/head.php": ["ArticlePage", "DefaultPage"],
		"site/templates/note.php": ["DefaultPage"],
		"site/snippets/aside.php": ["DefaultPage", "FormPage"]
	}
};

// coverimage is in the flat method list, so this is the scope overruling it
check("flags a model method one of the file's models does not provide", () => {
	const r = diagnoseFields("<?php echo $page->coverImage();", SCOPED, "site/snippets/head.php");

	assert.deepStrictEqual(msgs(r), ['Field or method "coverImage" not found on ArticlePage.']);
});

check("and stays quiet where every model provides it", () => {
	assert.deepStrictEqual(
		diagnoseFields("<?php echo $page->coverImage();", SCOPED, "site/templates/note.php"),
		[]
	);
});

// The flat list is what answers wherever the models are not known, which is
// every caller that passes no file and every file no template reaches
check("a file with no models keeps the flat list", () => {
	assert.deepStrictEqual(diagnoseFields("<?php echo $page->coverImage();", SCOPED), []);
	assert.deepStrictEqual(
		diagnoseFields("<?php echo $page->coverImage();", SCOPED, "site/snippets/blocks/card.php"),
		[]
	);
});

// A package's model is not the author's to change, the same axis ownCode uses
check("a package's model narrows nothing", () => {
	assert.deepStrictEqual(
		diagnoseFields("<?php echo $page->coverImage();", SCOPED, "site/snippets/aside.php"),
		[]
	);
});

// scanMethods does not track receivers, so anything but $page could be a child
// of another type entirely and the scope says nothing about it
check("only $page is scoped", () => {
	assert.deepStrictEqual(
		diagnoseFields("<?php echo $article->coverImage();", SCOPED, "site/snippets/head.php"),
		[]
	);
});

// A model method and a field can share a name, and the field is what the call
// resolves to on a model that has no such method
check("a name that is also a field is left alone", () => {
	assert.deepStrictEqual(
		diagnoseFields("<?php echo $page->headline();", SCOPED, "site/snippets/head.php"),
		[]
	);
});

// PHP method names are case-insensitive and Content::get() lowercases keys
check("comparison ignores case", () => {
	assert.deepStrictEqual(diagnoseFields("<?php echo $page->Headline();", M), []);
	assert.deepStrictEqual(diagnoseFields("<?php echo $page->isNotEmpty();", M), []);
});

// esc is a documented alias for escape, so the alias registry has to be read
check("accepts a field method alias", () => {
	assert.deepStrictEqual(diagnoseFields("<?php echo $page->title()->esc();", M), []);
});

check("never looks inside a comment, string or heredoc", () => {
	const src = [
		"<?php",
		"/** $page->fromADocblock() */",
		"// $page->fromAComment()",
		"$s = '$page->fromAString()';",
		"echo <<<HTML",
		"  $page->fromAHeredoc()",
		"HTML;"
	].join("\n");
	assert.deepStrictEqual(diagnoseFields(src, M), []);
});

check("the range covers the name only", () => {
	const text = "<?php echo $page->headlien();";
	const r = diagnoseFields(text, M);
	assert.strictEqual(text.slice(r[0].start, r[0].end), "headlien");
});

check("without the lists nothing is flagged", () => {
	assert.deepStrictEqual(diagnoseFields("<?php echo $page->anything();", { snippets: {} }), []);
});

// A template, controller and model named `note` all render pages/note, so the
// binding is convention and needs no type inference
check("narrows to the blueprint the file renders", () => {
	for (const file of [
		"site/templates/note.php",
		"site/controllers/note.php",
		"site/models/note.php"
	]) {
		assert.deepStrictEqual(labels(completeFields("<?php $page->", M, file)), ["headline", "buttons", "hint", "pinned"], file);
	}
});

// Roots are configurable in index.php, so `site/` is a default rather than a
// rule. The manifest reports what the project actually uses.
check("follows the roots the project configured", () => {
	const moved = { ...M, roots: { ...ROOTS, templates: "app/views" } };

	assert.deepStrictEqual(
		labels(completeFields("<?php $page->", moved, "app/views/note.php")),
		["headline", "buttons", "hint", "pinned"]
	);

	// The old location is no longer a template, so it binds to nothing
	assert.deepStrictEqual(
		labels(completeFields("<?php $page->", moved, "site/templates/note.php")),
		["headline", "intro", "logo", "buttons", "hint", "date", "pinned", "kicker", "hello"]
	);
});

// A representation renders through its own template, so it shares its blueprint
check("a representation binds to the template it belongs to", () => {
	assert.deepStrictEqual(
		labels(completeFields("<?php $page->", M, "site/templates/note.rss.php")),
		["headline", "buttons", "hint", "pinned"]
	);
});

check("a snippet has no binding, so it offers every field", () => {
	const r = labels(completeFields("<?php $page->", M, "site/snippets/card.php"));
	assert.deepStrictEqual(r, ["headline", "intro", "logo", "buttons", "hint", "date", "pinned", "kicker", "hello"]);
});

check("$site uses the site blueprint", () => {
	assert.deepStrictEqual(labels(completeFields("<?php $site->", M, "site/templates/note.php")), ["logo", "hello"]);
});

// Intelephense contributes 100 items at the same cursor, measured against the
// real server, so without this the project's own fields scatter among
// __call, apiUrl, contentFileData and dirname
check("fields lead whatever else the editor merges in", () => {
	for (const item of completeFields("<?php $page->", M, "site/templates/note.php")) {
		assert.strictEqual(item.sort, "!" + item.label);
	}
});

check("carries the field type as the detail", () => {
	const r = completeFields("<?php $page->", M, "site/templates/note.php");
	assert.strictEqual(r[0].detail, "text");
});

check("still offers while the name is half typed", () => {
	assert.deepStrictEqual(labels(completeFields("<?php $page->head", M, "site/templates/note.php")), ["headline", "buttons", "hint", "pinned"]);
});

check("offers nothing once the call is complete", () => {
	assert.deepStrictEqual(completeFields("<?php $page->headline();", M, "site/templates/note.php"), []);
});

check("offers nothing inside a comment", () => {
	assert.deepStrictEqual(completeFields("<?php // $page->", M, "site/templates/note.php"), []);
});

// A manifest from an older build has the right keys with the wrong shape.
// Reading it anyway would yield array indices as field names, which is worse
// than reading nothing
check("a manifest of the wrong shape is ignored, not misread", () => {
	const stale = { fields: { blueprints: {}, union: ["headline"] }, methods: ["title"] };
	assert.deepStrictEqual(completeFields("<?php $page->", stale, "site/templates/note.php"), []);
	assert.deepStrictEqual(diagnoseFields("<?php echo $page->children();", stale), []);
});

/* ------------------------------------------------------------------ */
/* Field methods                                                       */
/* ------------------------------------------------------------------ */

const first = (r) => r.filter((x) => x.sort !== undefined)[0];

check("leads with the conversion that suits the field type", () => {
	const r = completeFieldMethods("<?php $page->buttons()->", M, "site/templates/note.php");
	assert.strictEqual(first(r).label, "toStructure");
	assert.strictEqual(first(r).detail, "structure field");
});

// The table only sorts, so an unrecognised type still offers everything
check("an unmapped type still offers every field method", () => {
	const r = completeFieldMethods("<?php $page->hint()->", M, "site/templates/note.php");
	assert.strictEqual(r.length, Object.keys(M.fieldMethods).length);
	assert.ok(r.every((x) => x.detail === ""));
	assert.ok(r.every((x) => x.sort === undefined));
});

// The Kirby Cheatsheet Snippets extension contributes over a thousand entries
// whose prefixes start with `-`, which beats any digit
// A field is always called, and the cursor only belongs inside the parens when
// the method actually takes arguments
check("insertion carries the parentheses", () => {
	const fields = completeFields("<?php $page->", M, "site/templates/note.php");
	assert.strictEqual(fields.find((x) => x.label === "headline").insert, "headline()$0");

	const methods = completeFieldMethods("<?php $page->buttons()->", M, "site/templates/note.php");
	assert.strictEqual(methods.find((x) => x.label === "toStructure").insert, "toStructure()$0");
	assert.strictEqual(methods.find((x) => x.label === "escape").insert, "escape($0)");
});

check("the preferred conversion outranks a snippet prefix", () => {
	const r = completeFieldMethods("<?php $page->buttons()->", M, "site/templates/note.php");
	assert.ok(first(r).sort < "->clone()", first(r).sort);
});

check("offers nothing for a field that does not exist", () => {
	assert.deepStrictEqual(completeFieldMethods("<?php $page->nope()->", M, "site/templates/note.php"), []);
});

check("offers nothing before the second arrow", () => {
	assert.deepStrictEqual(completeFieldMethods("<?php $page->buttons()", M, "site/templates/note.php"), []);
});

// A field resolves because the content file has it, whether or not a blueprint
// declares it. Without this a project run with no Panel is reported wrong from
// top to bottom: 40 findings on one real site, all of them correct code.
check("a field only a content file has is not reported", () => {
	assert.deepStrictEqual(diagnoseFields("<?php $page->pinned()", M), []);
	assert.deepStrictEqual(diagnoseFields("<?php $site->hello()", M), []);
});

check("a name in neither blueprints nor content is still reported", () => {
	assert.strictEqual(diagnoseFields("<?php $page->headlien()", M).length, 1);
});

check("content fields are offered, and say where they came from", () => {
	const items = completeFields("<?php $page->", M, "site/templates/note.php");
	const pinned = items.find((item) => item.label === "pinned");

	// `detail` says what a name is, `documentation` says which blueprint the
	// list came from, and neither slot mixes the two
	assert.strictEqual(pinned?.detail, "content file");
	assert.strictEqual(pinned?.documentation, "pages/note");
	// Declared once, not twice: the blueprint entry keeps its type
	assert.deepStrictEqual(
		items.filter((item) => item.label === "headline").map((item) => item.detail),
		["text"]
	);
});

// The whole panel-less case: no blueprint of its own, so the old scope test
// fell through to the union and offered every field but this one
check("a template with only content still completes its own fields", () => {
	assert.deepStrictEqual(
		completeFields("<?php $page->", M, "site/templates/panelless.php").map((item) => item.label),
		["kicker"]
	);
});

check("a content-only field still offers its methods", () => {
	const items = completeFieldMethods("<?php $page->pinned()->", M, "site/templates/note.php");

	assert.deepStrictEqual(items.map((item) => item.label).sort(), Object.keys(M.fieldMethods).sort());
	// No declared type, so nothing is promoted over anything else
	assert.deepStrictEqual([...new Set(items.map((item) => item.sort))], [undefined]);
});

// PHP writes `[]` for a map with nothing in it, so a template with no
// blueprint of its own arrives looking like a list. Reading that as "wrong
// shape, offer nothing" cost every completion on a panel-less project, where
// no template has a blueprint and the content is the only schema there is.
check("a blueprint with no fields does not suppress its content fields", () => {
	const empty = {
		...M,
		fields: { ...M.fields, blueprints: { ...M.fields.blueprints, "pages/panelless": [] } }
	};

	assert.deepStrictEqual(
		labels(completeFields("<?php $page->", empty, "site/templates/panelless.php")),
		["kicker"]
	);
});

check("a non-empty array is still the wrong shape and offers nothing", () => {
	const stale = {
		...M,
		fields: { ...M.fields, blueprints: { ...M.fields.blueprints, "pages/note": ["headline"] } }
	};

	assert.deepStrictEqual(completeFields("<?php $page->", stale, "site/templates/note.php"), []);
});

check("a manifest with no content section behaves as before", () => {
	const { content, ...bare } = M;

	assert.deepStrictEqual(diagnoseFields("<?php $page->pinned()", bare).length, 1);
	assert.deepStrictEqual(
		completeFields("<?php $page->", bare, "site/templates/note.php").map((item) => item.label),
		["headline", "buttons", "hint"]
	);
});

// CONVERSIONS is the one editorial table here; corpus.js checks it against real
// projects, this checks it is at least internally coherent
check("every conversion names a real field method", () => {
	const known = new Set(["toStructure", "toBlocks", "toLayouts", "toObject", "toEntries",
		"toFiles", "toFile", "toPages", "toPage", "toUsers", "toUser", "toDate", "toTimestamp",
		"toBool", "toInt", "toFloat", "toUrl", "toLink", "split", "kt", "kti", "kirbytext", "escape"]);

	for (const [type, methods] of Object.entries(CONVERSIONS)) {
		for (const method of methods) {
			assert.ok(known.has(method), `${type} maps to unknown ${method}`);
		}
	}
});

/* snippet wrappers */

check("completes names inside a wrapper", () => {
	assert.deepStrictEqual(labels(complete(`<?= s('`, M)),
		["components/accordion", "components/button", "header"]);
});

check("a label is kept when completing the name it precedes", () => {
	const items = complete(`<?= s('o:`, M);

	assert.deepStrictEqual(items.map((item) => item.insert),
		["'o:components/accordion'", "'o:components/button'", "'o:header'"]);
});

check("a labelled name resolves to the snippet it names", () => {
	assert.deepStrictEqual(diagnose(`<?= s('o:header') ?><?= s('<header') ?>`, M), []);
});

check("a labelled name that misses is reported without its label", () => {
	assert.deepStrictEqual(msgs(diagnose(`<?= s('o:heade') ?>`, M)),
		['Snippet "heade" not found. Did you mean "header"?']);
});

check("a real name beats stripping a label off it", () => {
	assert.deepStrictEqual(diagnose(`<?php snippet('header');`, M), []);
});

check("cmd-click through a label points at the name", () => {
	const text = `<?= s('o:header') ?>`;
	const result = define(text, text.indexOf("header"), M);

	assert.strictEqual(result.target, "header");
	assert.strictEqual(text.slice(result.start, result.end), "header");
});

check("renaming through a label leaves the label alone", () => {
	const text = `<?= s('o:header') ?>\n<?= s('<header') ?>\n<?php snippet('header');`;
	const edits = renameEdits(text, "header", "top", M);

	assert.strictEqual(edits.length, 3);

	for (const edit of edits) {
		assert.strictEqual(text.slice(edit.start, edit.end), "header");
	}
});

check("completes a named argument as a pair without quotes", () => {
	const items = complete(`<?= s('components/button', var`, M);
	const insert = (label) => items.find((item) => item.label === label).insert;

	// A listed value lands the cursor between the quotes, an open one after
	assert.strictEqual(insert("variant"), "variant: '$0'");
	assert.strictEqual(insert("label"), "label: $0");
});

check("offers the parameters of an argument with nothing typed in it", () => {
	assert.deepStrictEqual(labels(complete(`<?= s('components/button', `, M)),
		["label", "variant", "compact"]);
});

check("completes the values of a named argument", () => {
	assert.deepStrictEqual(labels(complete(`<?= s('components/button', variant: '`, M)),
		["filled", "outlined", "text"]);
});

check("checks a named argument's key and value", () => {
	assert.deepStrictEqual(msgs(diagnose(`<?= s('components/button', varaint: 'x') ?>`, M)),
		['"varaint" is not a documented parameter of components/button.']);

	assert.deepStrictEqual(msgs(diagnose(`<?= s('components/button', variant: 'huge') ?>`, M)),
		['"huge" is not a valid variant. Expected: filled, outlined, text.']);
});

check("a scalar check still applies to a named argument", () => {
	assert.deepStrictEqual(msgs(diagnose(`<?= s('components/button', compact: 'yes') ?>`, M)),
		["compact expects bool|null, not a string."]);
});

check("reports a missing required parameter of a wrapper call", () => {
	assert.deepStrictEqual(msgs(diagnose(`<?= s('components/accordion', text: 'x') ?>`, M)),
		["components/accordion is missing required: title."]);
});

check("a closing call passes nothing and is not missing anything", () => {
	assert.deepStrictEqual(diagnose(`<?= s('c:components/accordion') ?>`, M), []);
});

check("the fix for a missing parameter writes a named argument", () => {
	const text = `<?= s('components/accordion', text: 'x') ?>`;
	const [fix] = fixes(text, text.indexOf("components/accordion"), M);

	assert.strictEqual(fix.title, "Add missing: title");
	assert.strictEqual(fix.edits[0].text, ", title: ''");
});

check("the fix for a labelled typo keeps the label", () => {
	const text = `<?= s('o:heade') ?>`;
	const [fix] = fixes(text, text.indexOf("heade"), M);

	assert.strictEqual(fix.title, "Change to 'o:header'");
	assert.strictEqual(fix.edits[0].text, "'o:header'");
});

check("an array handed to a wrapper is one value rather than the data", () => {
	assert.deepStrictEqual(msgs(diagnose(`<?= s('components/button', opts: ['nope' => 'x']) ?>`, M)),
		['"opts" is not a documented parameter of components/button.']);
});

check("snippet's own named arguments are never read as data", () => {
	assert.deepStrictEqual(
		diagnose(`<?php snippet('components/button', ['variant' => 'text'], return: true);`, M), []);
});

check("a positional argument is not read as a parameter", () => {
	assert.deepStrictEqual(diagnose(`<?= s('components/button', $data) ?>`, M), []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
