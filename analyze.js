/**
 * All completion and diagnostic decisions, as plain data in and plain data
 * out.
 */

const { scan, scanCalls, scanMethods, mask } = require("./scanner.js");

const I18N = ["t", "tt", "I18n::translate", "I18n::template"];

const isMap = (value) =>
	typeof value === "object" && value !== null && Array.isArray(value) === false;

// PHP writes `[]` for a map with nothing in it, which is what a template with
// no blueprint of its own looks like. A non-empty array is the old shape.
const fieldMap = (value) =>
	isMap(value) === true
		? value
		: Array.isArray(value) === true && value.length === 0
			? {}
			: null;

const snippetsOf = (manifest) => manifest.snippets ?? {};
const snippetOf = (manifest, name) => snippetsOf(manifest)[name];
const paramsOf = (manifest, name) => snippetOf(manifest, name)?.params;

/**
 * `$`, `}` and `\` drive VS Code's snippet syntax, so anything inserted
 * verbatim has to say so.
 */
const literally = (value) => String(value).replace(/([\\$}])/g, "\\$1");

/**
 * PHP unescapes `\'` inside single quotes, so a value carrying one has to be
 * written back the way it was read.
 */
const encode = (value, quote) =>
	quote === "'" ? String(value).replace(/([\\'])/g, "\\$1") : String(value);

// VS Code merges every provider's items into one list. `!` beats every letter
// and digit, including the `-` a snippet prefix starts with.
const lead = (value) => "!" + value;

// Letters, digits, dashes and slashes, the same shape the rename provider
// enforces before it moves a file
const NAMEABLE = /^[\w-]+(\/[\w-]+)*$/;

// The variables Kirby puts in scope itself, which are models by construction
const INJECTED = new Set([
	"$page", "$site", "$kirby", "$pages", "$file", "$files",
	"$user", "$users", "$block", "$blocks", "$item", "$structure", "$layout"
]);

/**
 * Whether an offset sits within a literal's text, between its quotes.
 */
function inside(literal, offset) {
	const last = literal.closed === true ? literal.end - 1 : literal.end;

	return offset > literal.start && offset <= last;
}

/**
 * What a completion may overwrite, or null where nothing safely can.
 */
function span(text, literal, offset) {
	const from = text.lastIndexOf("\n", offset - 1) + 1;

	// An opening quote on an earlier line means this is not a name being typed
	if (literal.start < from) {
		return null;
	}

	const to = text.indexOf("\n", offset);
	const line = to === -1 ? text.length : to;

	return {
		start: literal.start,
		end: literal.closed === true ? Math.min(literal.end, line) : offset
	};
}

/**
 * What to offer at a cursor offset, or nothing outside a `snippet()` string.
 */
function complete(text, manifest, offset = text.length) {
	const literals = scan(text);
	const open = literals.find((literal) => inside(literal, offset));

	if (open === undefined) {
		return [];
	}

	const replace = span(text, open, offset);

	if (replace === null) {
		return [];
	}

	const quote = text[open.start] === '"' ? '"' : "'";
	const quoted = (value) => quote + literally(encode(value, quote)) + quote;

	// Setting a range makes VS Code filter on the text that range covers, quotes
	// included, so a bare label matches nothing and the list empties
	const filtered = (value) => quote + encode(value, quote) + quote;

	if (open.kind === "name") {
		// Ignored snippets stay in the manifest so cmd-click and the checks
		// still reach them; only the list you pick from leaves them out
		return Object.entries(snippetsOf(manifest))
			.filter(([, entry]) => entry.ignored !== true)
			.map(([name]) => name)
			.sort()
			.map((name) => ({
				label: name,
				kind: "name",
				detail: snippetOf(manifest, name).summary || summarise(paramsOf(manifest, name)),
				documentation: "",
				replace,
				insert: quoted(name),
				filter: filtered(name),
				sort: lead(name)
			}));
	}

	const params = paramsOf(manifest, open.snippet);

	if (params === undefined) {
		return [];
	}

	if (open.kind === "key") {
		const used = new Set(
			literals
				.filter((l) => l.kind === "key" && l.call === open.call && l !== open)
				.map((l) => l.value)
		);

		// Completing over a key that already has a value must not write a second
		// arrow, so the pair is only ever completed where none exists yet
		const paired = /^\s*=>/.test(text.slice(open.end, open.end + 40));

		return Object.entries(params)
			.filter(([name, param]) => used.has(name) === false && param.injected !== true)
			.map(([name, param], index) => {
				const listed = param.values.length > 0;

				return {
						// Docblock order
					sort: lead(String(index).padStart(3, "0")),
					label: name,
					kind: "key",
					detail: param.type + (param.required === true ? " (required)" : ""),
					documentation: param.description,
					replace,
					filter: filtered(name),
					insert: paired
						? quoted(name)
						: listed
							// Landing between the quotes, where the value list applies
							? `${quoted(name)} => ${quote}$0${quote}`
							: `${quoted(name)} => $0`,
					retrigger: paired === false && listed,
					preselect: param.required === true
				};
			});
	}

	return (params[open.key]?.values ?? []).map((value, index) => ({
		label: value,
		kind: "value",
		detail: params[open.key].type,
		documentation: params[open.key].description,
		replace,
		filter: filtered(value),
		insert: quoted(value),
		sort: lead(String(index).padStart(3, "0"))
	}));
}

/**
 * Whether a snippet's parameter list is complete enough to call a key wrong.
 */
function documents(params) {
	return (
		params !== undefined &&
		Object.values(params).some(
			(param) => param.injected !== true && param.inferred !== true
		)
	);
}

function diagnose(text, manifest) {
	const literals = scan(text);
	const found = [];
	const known = snippetsOf(manifest);

	// A manifest that failed to generate carries none, and every call in the
	// project would then be reported at once
	const listed = Object.keys(known).length > 0;

	for (const literal of literals) {
		if (literal.closed === false) {
			continue;
		}

		if (literal.kind === "name") {
			if (listed === true && known[literal.value] === undefined) {
				const meant = closest(literal.value, Object.keys(known));

				found.push({
					start: literal.start,
					end: literal.end,
					message:
						`Snippet "${literal.value}" not found.` +
						(meant === null ? "" : ` Did you mean "${meant}"?`),
					severity: "warning"
				});
			}

			continue;
		}

		const params = paramsOf(manifest, literal.snippet);

		// Plenty of snippets carry only the `@var $page` hints Kirby's docs
		// suggest and declare their real parameters with `??=`
		if (documents(params) === false) {
			continue;
		}

		if (literal.kind === "key" && params[literal.value] === undefined) {
			found.push({
				start: literal.start,
				end: literal.end,
				message: `"${literal.value}" is not a documented parameter of ${literal.snippet}.`,
				severity: "warning"
			});
			continue;
		}

		if (literal.kind !== "value") {
			continue;
		}

		const param = params[literal.key];

		if (param === undefined) {
			continue;
		}

		if (param.values.length > 0 && param.values.includes(literal.value) === false) {
			found.push({
				start: literal.start,
				end: literal.end,
				message: `"${literal.value}" is not a valid ${literal.key}. Expected: ${param.values.join(", ")}.`,
				severity: "error"
			});
			continue;
		}

		if (param.scalar === false) {
			found.push({
				start: literal.start,
				end: literal.end,
				message: `${literal.key} expects ${param.type}, not a string.`,
				severity: "error"
			});
		}
	}

	found.push(...missingRequired(literals, manifest));

	return found.sort((a, b) => a.start - b.start);
}

/**
 * Only calls that pass at least one literal key are checked, so `snippet('x',
 * $data)` is never reported.
 */
function missingRequired(literals, manifest) {
	const calls = new Map();

	for (const literal of literals) {
		if (calls.has(literal.call) === false) {
			calls.set(literal.call, { name: null, keys: new Set() });
		}

		const call = calls.get(literal.call);

		if (literal.kind === "name") {
			call.name = literal.value;
			call.start = literal.start;
			call.end = literal.end;
		}

		if (literal.kind === "key") {
			call.keys.add(literal.value);
		}
	}

	const found = [];

	for (const call of calls.values()) {
		const missing = missingFor(manifest, call.name, call.keys);

		if (missing.length > 0) {
			found.push({
				start: call.start,
				end: call.end,
				message: `${call.name} is missing required: ${missing.join(", ")}.`,
				severity: "error"
			});
		}
	}

	return found;
}

/**
 * The candidate a wrong word was most likely meant to be, or null.
 */
function closest(value, candidates) {
	const limit = Math.max(2, Math.floor(value.length / 3));
	let best = null;
	let shortest = Infinity;

	for (const candidate of candidates) {
		const apart = distance(value.toLowerCase(), candidate.toLowerCase());

		if (apart < shortest && apart <= limit) {
			best = candidate;
			shortest = apart;
		}
	}

	return best;
}

/**
 * Fixes for what a diagnostic reported at an offset.
 */
function fixes(text, offset, manifest) {
	return [...snippetFixes(text, offset, manifest), ...typeFixes(text, offset)];
}

/**
 * What a callback registered under a Kirby extension key is handed.
 *
 * Editorial, like CONVERSIONS: read from Kirby rather than from the manifest.
 * Only `command` is in here because only `command` has ever fired. Across the
 * corpus the same parameter is written `function (CLI $cli)` **76** times and
 * bare twice, so this offers what the project already does everywhere else.
 */
const CALLBACKS = { command: "\\Kirby\\CLI\\CLI" };

/**
 * Typing the closure parameter a finding's receiver came from.
 *
 * `$cli->success()` is reported only because nothing says what `$cli` is. A
 * native type hint is what the surrounding code already uses, and once it is
 * there Intelephense resolves the receiver and the finding goes on its own.
 * Offered only where the type is known outright, never as a guess.
 */
function typeFixes(text, offset) {
	const call = scanMethods(text).find(
		(found) => offset >= found.start && offset <= found.end
	);

	if (call?.receiver == null || call.receiver.name.startsWith("$") === false) {
		return [];
	}

	const code = mask(text);
	const before = code.slice(0, call.receiver.start);
	const name = call.receiver.name;

	// The last closure whose parameters mention it. `[^()]*` gives up on a
	// default value containing parentheses, which is the right way to fail.
	const signatures = /(?:^|[^\w$])((?:static\s+)?function\s*\(([^()]*)\))/g;
	let signature = null;
	let match;

	while ((match = signatures.exec(before)) !== null) {
		if (new RegExp(`(^|,)\\s*\\${name}\\s*(,|$)`).test(match[2]) === true) {
			signature = match;
		}
	}

	if (signature === null) {
		return [];
	}

	// What the closure is registered as is the only thing that names the type,
	// and it is read from the raw text because `mask()` blanks every string,
	// this one included. Offsets survive masking, so they still line up.
	const key = /'(\w+)'\s*=>\s*$/.exec(
		text.slice(0, signature.index + signature[0].indexOf("function"))
	);

	const type = key === null ? undefined : CALLBACKS[key[1]];

	if (type === undefined) {
		return [];
	}

	const at =
		signature.index + signature[0].indexOf("(") + 1 + signature[2].indexOf(name);

	return [
		{
			title: `Add the ${type} type hint`,
			edits: [{ start: at, end: at, text: type + " " }]
		}
	];
}

function snippetFixes(text, offset, manifest) {
	const literals = scan(text);
	const at = literals.find(
		(literal) => offset >= literal.start && offset <= literal.end
	);

	if (at === undefined || at.closed === false) {
		return [];
	}

	const params = paramsOf(manifest, at.snippet);
	const quote = text[at.start] === '"' ? '"' : "'";
	const quoted = (value) => quote + encode(value, quote) + quote;
	const replace = (value) => [{ start: at.start, end: at.end, text: quoted(value) }];

	if (at.kind === "name") {
		if (snippetOf(manifest, at.value) === undefined) {
			const meant = closest(at.value, Object.keys(snippetsOf(manifest)));

			return [
				// Correcting first: a name one edit away from one that exists is
				// a likelier reading than a new snippet named almost the same
				...(meant === null
					? []
					: [{ title: `Change to ${quoted(meant)}`, edits: replace(meant) }]),
				// A fix that creates a file has to refuse a name that could land
				// outside the snippets root, and `snippet('../../x')` is one
				...(NAMEABLE.test(at.value) === true
					? [{ title: `Create snippet ${quoted(at.value)}`, create: at.value }]
					: [])
			];
		}

		const missing = missingFor(manifest, at.value, keysOf(literals, at.call));

		if (missing.length === 0) {
			return [];
		}

		// Inside the data array, behind the last literal the call passes
		const last = literals
			.filter((literal) => literal.call === at.call)
			.reduce((furthest, literal) => Math.max(furthest, literal.end), 0);

		return [
			{
				title: `Add missing: ${missing.join(", ")}`,
				edits: [
					{
						start: last,
						end: last,
						text: missing.map((name) => `, ${quoted(name)} => ${quote}${quote}`).join("")
					}
				]
			}
		];
	}

	if (params === undefined) {
		return [];
	}

	if (at.kind === "key" && params[at.value] === undefined) {
		const meant = closest(at.value, Object.keys(params).filter((name) => params[name].injected !== true));

		return meant === null ? [] : [{ title: `Change to ${quoted(meant)}`, edits: replace(meant) }];
	}

	if (at.kind === "value") {
		const values = params[at.key]?.values ?? [];

		if (values.length === 0 || values.includes(at.value) === true) {
			return [];
		}

		const meant = closest(at.value, values);

		return [
			// Best guess first: a wrong value is as often a changed mind as a typo
			...(meant === null ? [] : [{ title: `Change to ${quoted(meant)}`, edits: replace(meant) }]),
			...values
				.filter((value) => value !== meant)
				.map((value) => ({ title: `Change to ${quoted(value)}`, edits: replace(value) }))
		];
	}

	return [];
}

/**
 * The required parameters a call has not passed.
 */
function missingFor(manifest, snippet, passed) {
	const params = paramsOf(manifest, snippet);

	// No literal keys means a variable, which says nothing about its contents
	if (documents(params) === false || passed.size === 0) {
		return [];
	}

	return Object.entries(params)
		.filter(([key, param]) => param.required === true && passed.has(key) === false)
		.map(([key]) => key);
}

const keysOf = (literals, call) =>
	new Set(
		literals
			.filter((literal) => literal.kind === "key" && literal.call === call)
			.map((literal) => literal.value)
	);

/**
 * Every place one file spells a snippet name, as edits that rewrite it.
 */
function renameEdits(text, from, to) {
	return scan(text)
		.filter(
			(literal) =>
				literal.kind === "name" && literal.closed === true && literal.value === from
		)
		.map((literal) => ({ start: literal.start + 1, end: literal.end - 1, text: to }));
}

/**
 * `string|null` says twice what the grouping already says once, so the null
 * is dropped from anything shown as optional.
 */
function readable(param) {
	const parts = param.type
		.split("|")
		.map((p) => p.trim())
		.filter((p) => param.required === true || p !== "null");

	return parts.length === 0 ? param.type : parts.join(" | ");
}

// Bold name, code type: two adjacent code spans read as one grey smear
function row(name, param) {
	const description = param.description ? ` — ${param.description}` : "";
	return `- **${name}** \`${readable(param)}\`${description}`;
}

/**
 * Reads like documentation rather than a dump: the summary line first, then
 * what you must pass, then what you may.
 */
function describe(name, entry) {
	const params = Object.entries(entry.params).filter(([, p]) => p.injected !== true);
	const required = params.filter(([, p]) => p.required === true);
	const optional = params.filter(([, p]) => p.required !== true);

	const out = [`**${name}**`];

	if (entry.summary) {
		out.push(entry.summary);
	}

	if (params.length === 0) {
		out.push("_No parameters._");
		return out.join("\n\n");
	}

	// Headings would be noise when there is only ever one group
	if (required.length > 0 && optional.length > 0) {
		out.push("**Required**", required.map(([n, p]) => row(n, p)).join("\n"));
		out.push("**Optional**", optional.map(([n, p]) => row(n, p)).join("\n"));
	} else {
		out.push([...required, ...optional].map(([n, p]) => row(n, p)).join("\n"));
	}

	if (params.every(([, p]) => p.inferred === true)) {
		out.push("_Read from the code; add a docblock for types and allowed values._");
	}

	return out.join("\n\n");
}

function hover(text, offset, manifest) {
	for (const literal of scan(text)) {
		if (offset < literal.start || offset > literal.end) {
			continue;
		}

		const entry = snippetOf(manifest, literal.kind === "name" ? literal.value : literal.snippet);

		if (entry === undefined) {
			continue;
		}

		if (literal.kind === "name") {
			return {
				contents: describe(literal.value, entry),
				start: literal.start,
				end: literal.end
			};
		}

		const key = literal.kind === "key" ? literal.value : literal.key;
		const param = entry.params[key];

		if (param === undefined) {
			continue;
		}

		// For a literal union the type already is the list of allowed values
		const heading =
			`**${key}** \`${readable(param)}\`` + (param.required === true ? " · required" : "");

		return {
			contents: [heading, param.description].filter(Boolean).join("\n\n"),
			start: literal.start,
			end: literal.end
		};
	}

	return null;
}

/**
 * The snippet a PHP offset points at, as a path relative to the snippets
 * root.
 */
function define(text, offset, manifest) {
	for (const literal of scan(text)) {
		if (literal.kind !== "name" || offset < literal.start || offset > literal.end) {
			continue;
		}

		if (snippetOf(manifest, literal.value) === undefined) {
			return null;
		}

		// Inside the quotes, so the clickable range sits on the name itself
		return {
			target: literal.value,
			start: literal.start + 1,
			end: literal.end - 1
		};
	}

	return null;
}

/**
 * Every blueprint reference in a YAML document, with its exact offsets.
 */
function blueprintReferences(text) {
	const found = [];
	const key = /(?:^|\n)[ \t]*(?:-[ \t]*)?(extends|fieldsets):[ \t]*(.*)/g;
	const token = /[\w-]+(?:\/[\w-]+)*/g;
	let match;

	while ((match = key.exec(text)) !== null) {
		const inline = match[2];
		const from = match.index + match[0].length - inline.length;

		// `extends: fields/x` or `fieldsets: [a, b]` on the same line
		for (const value of inline.matchAll(token)) {
			found.push({ target: value[0], start: from + value.index });
		}

		if (inline.trim() !== "") {
			continue;
		}

		// `fieldsets:` followed by a block list, until the first line that is
		// not a list item. The cursor walks the text so offsets stay exact
		// even when an identical line appears elsewhere in the document.
		let cursor = match.index + match[0].length;

		for (const line of text.slice(cursor).split("\n").slice(1)) {
			cursor += 1;

			const item = /^[ \t]+-[ \t]*([\w-]+(?:\/[\w-]+)*)[ \t]*$/.exec(line);

			if (item === null) {
				break;
			}

			found.push({ target: item[1], start: cursor + line.indexOf(item[1]) });
			cursor += line.length;
		}
	}

	return found.map((r) => ({ ...r, end: r.start + r.target.length }));
}

/**
 * The blueprint a YAML offset points at, as a path without extension.
 */
function defineBlueprint(text, offset) {
	return (
		blueprintReferences(text).find(
			(r) => offset >= r.start && offset <= r.end
		) ?? null
	);
}

/**
 * The language files that define the translation key at a PHP offset.
 */
function defineTranslation(text, offset, manifest) {
	const project = manifest.translations?.project;
	const files = manifest.translations?.files;

	if (isMap(project) === false || isMap(files) === false) {
		return null;
	}

	const first = manifest.translations?.default;

	for (const call of scanCalls(text, I18N)) {
		if (call.literal === false || offset < call.start || offset > call.end) {
			continue;
		}

		const targets = Object.keys(project)
			.filter(
				(code) =>
					Array.isArray(project[code]) === true &&
					project[code].includes(call.value) === true &&
					typeof files[code] === "string"
			)
			.sort((a, b) => (a === first ? -1 : b === first ? 1 : a.localeCompare(b)))
			.map((code) => files[code]);

		return targets.length === 0
			? null
			: {
					targets,
					key: call.value,
					// Inside the quotes, so the clickable range is the key itself
					start: call.start + 1,
					end: call.end - 1
				};
	}

	return null;
}

/**
 * Where a language file writes a key, as an offset inside its quotes.
 */
function keyLine(text, key) {
	for (const quote of ["'", '"']) {
		const literal = quote + key + quote;

		for (let at = text.indexOf(literal); at !== -1; at = text.indexOf(literal, at + 1)) {
			if (/^\s*=>/.test(text.slice(at + literal.length)) === true) {
				return at + 1;
			}
		}
	}

	return 0;
}

/**
 * The fieldset a blueprint file defines, or null if it defines none.
 */
function fieldsetOf(file, roots) {
	if (/\.(yml|yaml)$/.test(file) === false) {
		return null;
	}

	const prefix = (roots ?? ROOTS).blueprints.replace(/\/+$/, "") + "/blocks/";

	return file.startsWith(prefix) === true
		? file.slice(prefix.length).replace(/\.(yml|yaml)$/, "")
		: null;
}

/**
 * A block's label references a field the block does not have.
 */
function diagnoseBlockLabels(text, manifest, file) {
	const type = fieldsetOf(file, manifest.roots);
	const names = type === null ? null : manifest.fieldsets?.[type];

	// `fieldsets` rather than the flattened `fields.blueprints`, where a label
	// naming a structure's inner field would look resolvable and is not
	if (Array.isArray(names) === false) {
		return [];
	}

	const fields = new Set(names);

	const problems = [];
	let offset = 0;

	for (const line of text.split("\n")) {
		const label = /^label:[ \t]*(.*)$/.exec(line);

		if (label === null) {
			offset += line.length + 1;
			continue;
		}

		const from = offset + line.length - label[1].length;

		// The Panel's own pattern, single braces and a missing space included
		for (const found of label[1].matchAll(/[{]{1,2}[\s]?(.*?)[\s]?[}]{1,2}/g)) {
			// Dots are property access into the value
			const name = found[1].split(".")[0];

			if (/^[\w-]+$/.test(name) === false || fields.has(name.toLowerCase()) === true) {
				continue;
			}

			const start = from + found.index + found[0].indexOf(name);
			const meant = closest(name.toLowerCase(), names);

			problems.push({
				start,
				end: start + name.length,
				message:
					`Field "${name}" not found in this block.` +
					(meant === null ? "" : ` Did you mean "${meant}"?`),
				severity: "warning"
			});
		}

		offset += line.length + 1;
	}

	return problems;
}

/**
 * The receivers a query check will reason about.
 */
const RECEIVERS = {
	page: "the page being edited, or each row's own page in a section",
	site: "the site",
	file: "the file being edited",
	user: "the user being edited",
	model: "whichever model this field belongs to",
	structureItem: "one row of a structure field",
	block: "one block"
};

// Kirby resolves case-insensitively, and the manifest is lowercased throughout
const RECEIVES = new Set(Object.keys(RECEIVERS).map((name) => name.toLowerCase()));

/**
 * What to offer at a cursor inside a blueprint query: the receiver, then a
 * field, then that field's methods.
 */
function completeQueries(text, manifest, offset = text.length, file = "") {
	const fields = manifest.fields;

	if (isMap(fields) === false) {
		return [];
	}

	const before = text.slice(0, offset);
	const line = before.slice(before.lastIndexOf("\n") + 1);

	// Either position a query can be started from: the value of a key Kirby
	// resolves outright, or inside an interpolation. The spacing is `*` rather
	// than `?` because `{{  page` is as valid as `{{ page`.
	const opens = `(?:^[ \\t]*(?:-[ \\t]*)?(?:query|parent|fetch|options):[ \\t]*|\\{\\{[ \\t]*)`;

	// A fieldset's own label is resolved by the Panel against the block's
	// content, so offer that and nothing else. Same list diagnoseBlockLabels
	// checks against, so the two cannot contradict each other.
	const fieldset = /^label:/.test(line) === true ? fieldsetOf(file, manifest.roots) : null;

	if (fieldset !== null) {
		const own = manifest.fieldsets?.[fieldset];

		return Array.isArray(own) === false
			? []
			: own.map((name) => ({
					label: name,
					kind: "field",
					detail: "block field",
					documentation: "resolved by the Panel, not by Kirby",
					insert: name
				}));
	}

	const declared = fieldMap(fields.union) ?? {};
	const written = contentFields(manifest);
	const receiver = (name) => RECEIVES.has(name.toLowerCase());

	// A name already written continues past the cursor
	const trailing = /^\w*/.exec(text.slice(offset))[0].length;

	// `pad` is whitespace between the dot and the cursor, which Kirby would read
	// as part of the segment name, so the range swallows it. VS Code filters on
	// the text a range covers, so `filterText` has to carry it too.
	const overwrite = (typed, pad) => ({
		replace: { start: offset - pad.length - typed.length, end: offset + trailing },
		filter: (value) => pad + value
	});

	// A field's own methods, which is where `page.date.toDate('Ymd')` comes
	// from: 23 of the 25 argument-bearing queries in the corpus are that shape
	const chained = new RegExp(opens + `([A-Za-z_]\\w*)\\.(\\w+)\\.(\\w*)([ \\t]*)$`).exec(line);
	const all = manifest.fieldMethods;

	if (chained !== null && receiver(chained[1]) === true && isMap(all) === true) {
		const type = declared[chained[2].toLowerCase()] ?? written[chained[2].toLowerCase()];

		// A method's return type is not in the manifest, so only a field can be
		// followed up. `page.children.` is a real query and unanswerable here.
		if (type === undefined) {
			return [];
		}

		const preferred = CONVERSIONS[type] ?? [];
		const { replace, filter } = overwrite(chained[3], chained[4]);

		return Object.entries(all).map(([name, arity]) => ({
			label: name,
			kind: "method",
			detail: preferred.includes(name) === true ? `${type} field` : "",
			documentation: "",
			replace,
			filter: filter(name),
			// Kirby's query syntax drops the parentheses where there is nothing
			// to put in them: `file.alt.isEmpty`, but `page.date.toDate('Ymd')`
			insert: arity > 0 ? `${name}($0)` : name,
			sort: preferred.includes(name) === true ? lead(name) : undefined
		}));
	}

	const at = new RegExp(opens + `([A-Za-z_]\\w*)\\.(\\w*)([ \\t]*)$`).exec(line);

	// Nothing typed yet, so the receiver is what there is to offer. Without this
	// an empty `{{ }}` answers with nothing at all, which reads as broken.
	if (at === null) {
		const bare = new RegExp(opens + `(\\w*)([ \\t]*)$`).exec(line);

		if (bare === null) {
			return [];
		}

		const { replace, filter } = overwrite(bare[1], bare[2]);

		return Object.entries(RECEIVERS).map(([name, what]) => ({
			label: name,
			kind: "field",
			detail: "receiver",
			documentation: what,
			replace,
			filter: filter(name),
			insert: name
		}));
	}

	if (receiver(at[1]) === false) {
		return [];
	}

	const { replace, filter } = overwrite(at[2], at[3]);

	return [...new Set([...Object.keys(declared), ...Object.keys(written)])]
		.map((name) => ({
			label: name,
			kind: "field",
			detail: declared[name] ?? "content file",
			documentation: at[1],
			replace,
			filter: filter(name),
			insert: name
		}));
}

/* ------------------------------------------------------------------ */
/* Blueprint fields                                                    */
/* ------------------------------------------------------------------ */

/**
 * Field names the project's content files carry, for one scope or for all.
 */
function contentFields(manifest, scope = null) {
	const scopes = manifest.content;

	if (isMap(scopes) === false) {
		return {};
	}

	if (scope !== null) {
		return isMap(scopes[scope]) === true ? scopes[scope] : {};
	}

	return Object.assign({}, ...Object.values(scopes).filter(isMap));
}

/**
 * `$page->headlien()` returns an empty Field and renders nothing, with no
 * error even under debug.
 */
function diagnoseFields(text, manifest) {
	const union = manifest.fields?.union;
	const methods = manifest.methods;

	// Without both lists every call would look wrong
	if (isMap(union) === false || Array.isArray(methods) === false) {
		return [];
	}

	const known = new Set([
		...Object.keys(union),
		...Object.keys(contentFields(manifest)),
		// Reachable only on a structure item, so completion never offers them
		...Object.keys(isMap(manifest.structures) === true ? manifest.structures : {}),
		...methods
	]);

	return scanMethods(text)
		.filter((call) => known.has(call.name.toLowerCase()) === false)
		.map((call) => ({
			start: call.start,
			end: call.end,
			// Carried so a caller that can resolve types may drop the ones whose
			// receiver is not a model at all. Nothing here resolves anything.
			receiver: call.receiver,
			message: `Field or method "${call.name}" not found.`,
			severity: "warning"
		}));
}

/**
 * Whether a resolved receiver type rules a finding out.
 *
 * True only for a concrete class that is no kind of model. `mixed`, `object`
 * and an unresolved receiver all answer false, so the check keeps reporting
 * exactly as it does today wherever the type is not known. Measured across the
 * corpus, no true finding resolves to a concrete non-model class, which is what
 * makes suppressing on a positive answer safe.
 */
function suppresses(type, manifest, receiver) {
	const models = manifest?.models;

	if (Array.isArray(models) === false || models.length === 0) {
		return false;
	}

	// Kirby hands these to every template and snippet, so whatever a language
	// server makes of one it is a model, and no answer about it is worth acting
	// on. Measured: 0 of 327 correct suppressions have a base named this way, so
	// the guard is free, and it is what keeps `$page->title()->vaue()` reported
	// when the server says something strange about `$page`.
	if (INJECTED.has(String(receiver ?? "")) === true) {
		return false;
	}

	const known = new Set(models.map((name) => name.replace(/^\\+/, "").toLowerCase()));

	const alternatives = String(type ?? "")
		.split("|")
		// `?Page` and `Page[]` are the same class as far as this is concerned
		.map((name) => name.trim().replace(/^[?\\]+/, "").replace(/(\[\])+$/, "").toLowerCase())
		.filter((name) => name !== "" && name !== "null");

	if (alternatives.length === 0) {
		return false;
	}

	// Only something shaped like a class reference counts, rather than a list of
	// the scalars to reject. The corpus caught why: a hover came back as `unset`,
	// which is no class, and an allowlist let it suppress a real typo in
	// `$page->title()->vaue()`. Anything unnamespaced and lowercase is a keyword
	// or a scalar, and either way it is not a class we can rule on.
	const named = (name) => name.includes("\\") === true || /^[A-Z]/.test(name) === true;

	// A model among the alternatives, or anything unpinned, says nothing either way
	return alternatives.every(
		(name) => known.has(name) === false && named(name) === true
	);
}

/**
 * Whether a call's second argument short-circuits the lookup, which makes an
 * unknown key deliberate rather than wrong.
 */
function fallsBack(call) {
	if (call.second === "none" || call.second === "null") {
		return false;
	}

	// A variable could be a string at runtime, so say nothing either way
	if (call.second === "other") {
		return true;
	}

	return call.name === "t" || call.name === "I18n::translate"
		? true
		: call.second === "string";
}

/**
 * Translation keys that resolve nowhere.
 */
function diagnoseTranslations(text, manifest) {
	const keys = manifest.translations?.resolvable;

	if (Array.isArray(keys) === false || keys.length === 0) {
		return [];
	}

	const known = new Set(keys);

	return scanCalls(text, I18N)
		.filter(
			(call) =>
				call.literal === true &&
				fallsBack(call) === false &&
				known.has(call.value) === false
		)
		.map((call) => {
			const meant = closest(call.value, keys);

			return {
				start: call.start,
				end: call.end,
				message:
					`Translation key "${call.value}" not found.` +
					(meant === null ? "" : ` Did you mean "${meant}"?`),
				severity: "warning"
			};
		});
}

/**
 * Collection names that resolve nowhere.
 */
function diagnoseCollections(text, manifest) {
	const names = manifest.collections;

	// An empty list is a project with no collections, which is also a project
	// where nothing calls for one. Reading nothing must not flag everything.
	if (Array.isArray(names) === false || names.length === 0) {
		return [];
	}

	const known = new Set(names);

	return scanCalls(text, ["collection"])
		.filter((call) => call.literal === true && known.has(call.value) === false)
		.map((call) => {
			const meant = closest(call.value, names);

			return {
				start: call.start,
				end: call.end,
				message:
					`Collection "${call.value}" not found.` +
					(meant === null ? "" : ` Did you mean "${meant}"?`),
				severity: "error"
			};
		});
}

/**
 * Keys the other language files define and this one does not.
 */
function diagnoseLanguages(text, manifest, file) {
	const project = manifest.translations?.project;
	const files = manifest.translations?.files;

	if (isMap(project) === false || isMap(files) === false) {
		return [];
	}

	const path = String(file).replace(/\\/g, "/");
	const code = Object.keys(files).find((language) => path.endsWith(files[language]));

	if (code === undefined || Array.isArray(project[code]) === false) {
		return [];
	}

	// Against the default language, not the union of all of them. Both give the
	// same answer on every real project measured, but a union means one typo in
	// one file reports itself as missing from every other file.
	const reference = manifest.translations?.default;

	if (typeof reference !== "string" || code === reference) {
		return [];
	}

	if (Array.isArray(project[reference]) === false) {
		return [];
	}

	// A file with no `translations` block at all is a stub, and saying nothing
	// is the same courtesy an undocumented snippet gets
	const at = /['"]?translations['"]?\s*=>/.exec(text);

	if (at === null) {
		return [];
	}

	const mine = new Set(project[code]);
	const missing = project[reference].filter((key) => mine.has(key) === false).sort();

	if (missing.length === 0) {
		return [];
	}

	const shown = missing.slice(0, 5);

	return [
		{
			start: at.index,
			end: at.index + at[0].length,
			message:
				`${missing.length} ${missing.length === 1 ? "key is" : "keys are"} defined in ` +
				`${reference} but missing here: ${shown.join(", ")}` +
				(missing.length > shown.length ? ` and ${missing.length - shown.length} more.` : "."),
			severity: "information"
		}
	];
}

/**
 * What each resolvable `t()` call in a file actually says, as a hint to show
 * beside it.
 */
function previewTranslations(text, manifest) {
	const preview = manifest.translations?.preview;

	if (isMap(preview) === false) {
		return [];
	}

	return scanCalls(text, I18N)
		.filter((call) => call.literal === true && preview[call.value] !== undefined)
		.map((call) => ({ offset: call.end, text: preview[call.value] }));
}

/**
 * Translation keys to offer inside `t('…')`.
 */
function completeTranslations(text, manifest, offset = text.length) {
	const keys = manifest.translations?.resolvable;

	if (Array.isArray(keys) === false) {
		return [];
	}

	const at = new RegExp(
		`(?:^|[^\\w$>-])(?:${I18N.join("|")})\\s*\\(\\s*(['"])([^'"]*)$`
	).exec(text.slice(0, offset));

	if (at === null) {
		return [];
	}

	const quote = at[1];
	const start = offset - at[2].length - 1;

	// Include the closing quote where the editor has already added one, so the
	// completion replaces the whole literal rather than leaving a stray
	const replace = { start, end: text[offset] === quote ? offset + 1 : offset };

	return keys.map((key) => ({
		label: key,
		kind: "key",
		detail: "translation",
		documentation: "",
		replace,
		insert: quote + literally(key) + quote,
		filter: quote + key + quote,
		sort: lead(key)
	}));
}

/**
 * A field or method is always called, so the parentheses come with it.
 */
function call(name, arity) {
	return arity > 0 ? `${name}($0)` : `${name}()$0`;
}

/**
 * Where a stock Kirby keeps things.
 */
const ROOTS = {
	snippets: "site/snippets",
	blueprints: "site/blueprints",
	templates: "site/templates",
	controllers: "site/controllers",
	models: "site/models",
	collections: "site/collections",
	plugins: "site/plugins",
	languages: "site/languages"
};

/**
 * Where the field and snippet checks are answerable: the project's own code.
 *
 * They read a file as if the author could fix it. A vendored plugin is the
 * clearest case where that is false, but the directory is the wrong axis on its
 * own: skipping all of `site/plugins` also skips the `site` and `methods`
 * plugins a project writes for itself, where the findings are real. `packages`
 * carries the ones the generator found a `composer.json` in.
 *
 * Both callers ask here so a real window and the corpus cannot disagree about
 * it, which they did: the corpus scoped this and the editor did not.
 */
function ownCode(file, roots, packages = []) {
	const normalised = String(file).replace(/\\/g, "/");
	const under = (dir) => normalised.startsWith(String(dir).replace(/\\/g, "/") + "/");

	if (Array.isArray(packages) === true && packages.some(under) === true) {
		return false;
	}

	if (under(roots?.plugins ?? ROOTS.plugins) === true) {
		return true;
	}

	return ["snippets", "templates", "controllers", "models"].some((key) =>
		under(roots?.[key] ?? ROOTS[key])
	);
}

/**
 * The blueprint governing a file, from its path.
 */
function blueprintFor(file, roots) {
	const normalised = String(file).replace(/\\/g, "/");

	if (normalised.endsWith(".php") === false) {
		return null;
	}

	for (const key of ["templates", "controllers", "models"]) {
		const prefix = (roots?.[key] ?? ROOTS[key]).replace(/\\/g, "/") + "/";

		if (normalised.startsWith(prefix) === false) {
			continue;
		}

		// A representation renders through its own template, so `feed.rss.php`
		// is governed by the `feed` blueprint
		const name = normalised.slice(prefix.length, -4);
		const dot = name.indexOf(".", name.lastIndexOf("/") + 1);

		return "pages/" + (dot === -1 ? name : name.slice(0, dot));
	}

	return null;
}

// The blueprint a receiver reads from, or null for all of them. Shared so
// fields and their methods cannot disagree.
function scopeFor(receiver, manifest, file) {
	if (receiver === "$site") {
		return "site";
	}

	const scoped = receiver === "$page" ? blueprintFor(file, manifest.roots) : null;

	// Neither a blueprint nor content of its own: every field beats none
	return manifest.fields?.blueprints?.[scoped] !== undefined ||
		isMap(manifest.content?.[scoped]) === true
		? scoped
		: null;
}

/**
 * Fields to offer after `->`, narrowed to this file's blueprint where the
 * path allows and falling back to every field otherwise.
 */
function completeFields(text, manifest, file) {
	const fields = manifest.fields;

	if (isMap(fields) === false) {
		return [];
	}

	// Immediately after `->`, still on the name being typed
	const at = /(\$\w+)\s*->\s*(\w*)$/.exec(mask(text));

	if (at === null) {
		return [];
	}

	const scope = scopeFor(at[1], manifest, file);

	// One axis per slot: `detail` says what a name is, `documentation` says
	// which blueprint the list came from. Mixing a source into the scope line
	// made two answers to different questions sit in the same place.
	const from = scope ?? "not scoped to one blueprint";

	// A template can have content and no blueprint at all
	const declared = fieldMap(
		scope === null ? fields.union : (fields.blueprints?.[scope] ?? {})
	);
	const written = contentFields(manifest, scope);

	if (declared === null) {
		return [];
	}

	// Declared first, so a blueprint's type wins where content has it too
	return [...new Set([...Object.keys(declared), ...Object.keys(written)])].map((name) => ({
		label: name,
		kind: "field",
		// A content file carries no type, and guessing one from the value would
		// be wrong the first time a field is empty
		detail: Object.hasOwn(declared, name) === true ? declared[name] : "content file",
		documentation: from,
		insert: call(name, 0),
		// Intelephense offers 100 Page methods at the same cursor once the file
		// carries a `@var` docblock, and this project's own fields are what the
		// person typing came for. Only breaks ties: once anything is typed, the
		// editor's own match score decides.
		sort: lead(name)
	}));
}


/**
 * Which conversion suits which blueprint field type.
 */
const CONVERSIONS = {
	structure: ["toStructure"],
	blocks: ["toBlocks"],
	layout: ["toLayouts"],
	object: ["toObject"],
	entries: ["toEntries"],
	files: ["toFiles", "toFile"],
	pages: ["toPages", "toPage"],
	users: ["toUsers", "toUser"],
	date: ["toDate", "toTimestamp"],
	time: ["toDate"],
	toggle: ["toBool"],
	checkboxes: ["split"],
	multiselect: ["split"],
	tags: ["split"],
	number: ["toInt", "toFloat"],
	range: ["toInt", "toFloat"],
	url: ["toUrl"],
	link: ["toLink"],
	writer: ["kt", "kti"],
	textarea: ["kt", "kirbytext"],
	text: ["escape"]
};

/**
 * Field methods to offer after `$page->buttons()->`, with the ones that suit
 * that field's blueprint type sorted to the top.
 */
function completeFieldMethods(text, manifest, file) {
	const all = manifest.fieldMethods;

	if (isMap(all) === false || isMap(manifest.fields) === false) {
		return [];
	}

	// `$page->buttons()->to`, one level only
	const at = /(\$\w+)\s*->\s*(\w+)\s*\(\s*\)\s*->\s*(\w*)$/.exec(mask(text));

	if (at === null) {
		return [];
	}

	const [, receiver, field] = at;
	const scope = scopeFor(receiver, manifest, file);
	const name = field.toLowerCase();

	const source = fieldMap(
		scope === null ? manifest.fields.union : manifest.fields.blueprints?.[scope]
	);

	// A content-only field is real, so it earns the full list
	const type = (source?.[name] ?? contentFields(manifest, scope)[name]);

	if (type === undefined) {
		return [];
	}

	const preferred = CONVERSIONS[type] ?? [];

	// `!` because a snippet prefix like `->clone()` starts with `-` (ASCII 45)
	// and would otherwise sort above a digit. The Kirby Cheatsheet Snippets
	// extension contributes over a thousand of those.
	return Object.entries(all).map(([name, arity]) => {
		const suits = preferred.includes(name);

		return {
			label: name,
			kind: "method",
			detail: suits === true ? `${type} field` : "",
			documentation: "",
			insert: call(name, arity),
			sort: suits === true ? "!" + name : undefined
		};
	});
}

/* ------------------------------------------------------------------ */
/* KirbyTags                                                           */
/* ------------------------------------------------------------------ */

// Mirrors Kirby's own lookahead in KirbyTags::parse, `(?=\([a-z0-9_-]+:)`
// case-insensitively, so this sees exactly what Kirby would treat as a tag
const TAG = /\(([a-zA-Z0-9_-]+):/g;

function distance(a, b) {
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

	for (let i = 1; i <= a.length; i++) {
		const current = [i];

		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min(
				previous[j] + 1,
				current[j - 1] + 1,
				previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
			);
		}

		previous = current;
	}

	return previous[b.length];
}

/**
 * Kirby treats any `(word: …)` as a tag attempt and silently returns the raw
 * text when the word is not registered.
 */
function nearest(name, tags) {
	if (name.length < 4) {
		return null;
	}

	for (const known of Object.keys(tags)) {
		if (known.length >= 4 && distance(name.toLowerCase(), known) <= 2) {
			return known;
		}
	}

	return null;
}

const tagsOf = (manifest) => manifest.tags ?? {};

/**
 * Tag names for a half-typed `(`, or an empty array anywhere else.
 */
function completeTags(text, manifest) {
	// Only immediately after the paren, before any colon has been typed
	if (/\([a-zA-Z][\w-]*$|\($/.test(text) === false) {
		return [];
	}

	return Object.entries(tagsOf(manifest))
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, attrs]) => ({
			label: name,
			kind: "tag",
			detail: attrs.length === 0 ? "" : attrs.join(", "),
			documentation: ""
		}));
}

/**
 * A mistyped tag is the quietest failure in Kirby: KirbyTags::parse catches
 * the "Undefined tag type" exception and returns the raw text, so it renders
 * as literal text forever, with no log entry and no effect from debug mode.
 */
// `(https://example.com)` matches Kirby's tag lookahead but is a URL in
// parentheses, never a mistyped tag, and it is common enough to bury the rest
const SCHEMES = ["http", "https", "mailto", "ftp", "ftps", "sms", "geo"];

function diagnoseTags(text, manifest, mode = "all") {
	const tags = tagsOf(manifest);

	// Without a registry every tag would look wrong
	if (mode === "off" || Object.keys(tags).length === 0) {
		return [];
	}

	const found = [];
	TAG.lastIndex = 0;
	let match;

	while ((match = TAG.exec(text)) !== null) {
		const name = match[1];
		const lower = name.toLowerCase();

		if (tags[lower] !== undefined || SCHEMES.includes(lower) === true) {
			continue;
		}

		const meant = nearest(name, tags);

		if (meant === null && mode !== "all") {
			continue;
		}

		const start = match.index + 1;

		found.push({
			start,
			end: start + name.length,
			message:
				`Unknown KirbyTag "${name}", so this renders as plain text.` +
				(meant === null ? "" : ` Did you mean "${meant}"?`),
			severity: "warning"
		});
	}

	return found;
}

function summarise(params) {
	const names = Object.keys(params);
	return names.length === 0 ? "no documented parameters" : names.join(", ");
}

module.exports = {
	complete, diagnose, hover, define, defineBlueprint, defineTranslation, keyLine,
	diagnoseBlockLabels, completeQueries,
	completeTags, diagnoseTags, diagnoseFields, completeFields, completeFieldMethods,
	CONVERSIONS, ROOTS, ownCode, suppresses, fixes, renameEdits,
	diagnoseTranslations, diagnoseCollections, diagnoseLanguages, completeTranslations,
	previewTranslations
};
