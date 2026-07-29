/**
 * Every check, over a whole project on disk.
 */

const fs = require("node:fs");
const path = require("node:path");
const {
	diagnose,
	diagnoseFields,
	diagnoseTranslations,
	diagnoseCollections,
	diagnoseBlockLabels,
	ownCode,
	suppresses
} = require("./analyze.js");

function files(dir, extensions) {
	if (fs.existsSync(dir) === false) {
		return [];
	}

	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);

		if (entry.isDirectory() === true) {
			return files(full, extensions);
		}

		return extensions.some((e) => entry.name.endsWith(e)) ? [full] : [];
	});
}

/**
 * Every problem in a project, each carrying the file it is in and the offsets
 * it covers, so the caller can render a range or a line as it likes.
 */
function problems(root, index, types = {}) {
	const found = [];

	// The relative path is passed on as well, because a language file is checked
	// against the language it is rather than against its contents alone
	const scan = (list, check) => {
		for (const file of list) {
			const relative = path.relative(root, file);

			for (const problem of check(fs.readFileSync(file, "utf8"), index, relative)) {
				found.push({ ...problem, file: relative });
			}
		}
	};

	const from = (name) => files(path.join(root, index.roots?.[name] ?? "site/" + name), [".php"]);

	// Translation and collection checks read all of site/, plugins included: two
	// corpus projects call t() nowhere else, and a plugin's own keys are in the
	// manifest by construction, so they are answerable.
	const everywhere = files(path.join(root, "site"), [".php"]);

	// A root can sit outside site/, so both lists are walked and then filtered
	// by the same predicate the editor applies, rather than by this walk alone
	const own = [...new Set([...everywhere, ...["snippets", "templates", "controllers", "models"].flatMap(from)])]
		.filter((file) => ownCode(path.relative(root, file), index.roots, index.packages));

	scan(own, diagnose);
	scan(own, diagnoseFields);
	scan(everywhere, diagnoseTranslations);
	scan(everywhere, diagnoseCollections);
	// Blueprints are YAML, so from() is no help: it hardcodes .php
	const blueprints = files(
		path.join(root, index.roots?.blueprints ?? "site/blueprints"),
		[".yml", ".yaml"]
	);

	scan(blueprints, diagnoseBlockLabels);

	// The editor resolves a receiver's type through the language server and drops
	// the findings whose receiver is no kind of model. Those answers are recorded
	// by types.js so this can apply the same rule without one in the loop, which
	// is what keeps a recorded baseline equal to what a window shows.
	return found.filter(
		(problem) =>
			problem.receiver == null ||
			suppresses(types[`${problem.file}:${problem.receiver.start}`], index, problem.receiver.name) === false
	);
}

/**
 * The same problems as one sorted line each, which is the shape the corpus
 * records and compares.
 */
function findings(root, index, types = {}) {
	return problems(root, index, types)
		.map((problem) => `${problem.file}: ${problem.message}`)
		.sort();
}

module.exports = { files, problems, findings };
