const assert = require("node:assert");
const { scan, scanMethods } = require("../scanner.js");

let pass = 0, fail = 0;
const check = (name, fn) => {
	try { fn(); pass++; console.log("  ok   " + name); }
	catch (e) { fail++; console.log("  FAIL " + name + "\n       " + e.message); }
};
const kinds = r => r.map(l => [l.kind, l.snippet, l.key, l.value]);

check("snippet name", () => {
	assert.deepStrictEqual(kinds(scan(`<?php snippet('components/button');`)),
		[["name", null, null, "components/button"]]);
});

check("keys and values", () => {
	assert.deepStrictEqual(kinds(scan(`<?php snippet('components/button', ['variant' => 'outlined']);`)), [
		["name", null, null, "components/button"],
		["key", "components/button", null, "variant"],
		["value", "components/button", "variant", "outlined"],
	]);
});

check("multiple pairs keep their own keys", () => {
	const r = scan(`<?php snippet('c/b', ['label' => 'Mehr', 'variant' => 'text']);`);
	const values = r.filter(l => l.kind === "value");
	assert.deepStrictEqual(values.map(v => [v.key, v.value]), [["label","Mehr"],["variant","text"]]);
});

check("multi-line call", () => {
	const r = scan(`<?php
snippet('components/button', [
	'label'   => 'Mehr',
	'variant' => 'outlined',
]);`);
	assert.deepStrictEqual(r.filter(l => l.kind === "value").map(v => v.value), ["Mehr", "outlined"]);
});

check("parens and brackets inside a value", () => {
	const r = scan(`<?php snippet('c/b', ['label' => 'Hi (there) [ok]', 'variant' => 'text']);`);
	assert.deepStrictEqual(r.filter(l => l.kind === "value").map(v => v.value), ["Hi (there) [ok]", "text"]);
});

check("nested array does not lose the frame", () => {
	const r = scan(`<?php snippet('c/b', ['attributes' => ['data-x' => 'y'], 'variant' => 'text']);`);
	assert.strictEqual(r.find(l => l.kind === "value" && l.key === "variant").value, "text");
});

check("nested snippet() call is attributed correctly", () => {
	const r = scan(`<?php snippet('outer', ['x' => snippet('inner', ['variant' => 'text'], true)]);`);
	assert.strictEqual(r.find(l => l.value === "text").snippet, "inner");
});

check("docblock example is ignored", () => {
	const r = scan(`<?php
/**
 * snippet('c/b', ['variant' => 'nonsense']);
 */
snippet('c/b', ['variant' => 'text']);`);
	assert.strictEqual(r.filter(l => l.kind === "value").length, 1);
});

check("line comment is ignored", () => {
	const r = scan(`<?php
// snippet('c/b', ['variant' => 'nonsense']);
snippet('c/b', ['variant' => 'text']);`);
	assert.strictEqual(r.filter(l => l.kind === "value").length, 1);
});

check("unterminated name reports closed:false", () => {
	const r = scan(`<?php snippet('`);
	assert.deepStrictEqual([r.at(-1).kind, r.at(-1).closed], ["name", false]);
});

check("unterminated key", () => {
	const r = scan(`<?php snippet('c/b', ['`);
	assert.deepStrictEqual([r.at(-1).kind, r.at(-1).snippet, r.at(-1).closed], ["key", "c/b", false]);
});

check("unterminated value", () => {
	const r = scan(`<?php snippet('c/b', ['variant' => '`);
	assert.deepStrictEqual([r.at(-1).kind, r.at(-1).key, r.at(-1).closed], ["value", "variant", false]);
});

check("no space around the arrow", () => {
	const r = scan(`<?php snippet('c/b',['variant'=>'text']);`);
	assert.strictEqual(r.find(l => l.kind === "value").value, "text");
});

check("double quotes", () => {
	const r = scan(`<?php snippet("c/b", ["variant" => "text"]);`);
	assert.strictEqual(r.find(l => l.kind === "value").value, "text");
});

check("escaped quote in a value is decoded", () => {
	const r = scan(`<?php snippet('c/b', ['label' => 'it\\'s', 'variant' => 'text']);`);
	assert.deepStrictEqual(r.filter(l => l.kind === "value").map(v => v.value), ["it's", "text"]);
});

check("not a snippet call", () => {
	assert.deepStrictEqual(scan(`<?php mysnippet('c/b', ['variant' => 'x']);`), []);
	assert.deepStrictEqual(scan(`<?php $obj->snippet('c/b', ['variant' => 'x']);`), []);
});

check("return: true third argument is ignored", () => {
	const r = scan(`<?php snippet('c/b', ['variant' => 'text'], return: true);`);
	assert.strictEqual(r.find(l => l.kind === "value").value, "text");
});

check("literals are grouped by call", () => {
	const r = scan(`<?php
snippet('a', ['x' => '1']);
snippet('b', ['y' => '2']);`);
	const a = r.filter(l => l.snippet === "a" || (l.kind === "name" && l.value === "a"));
	const b = r.filter(l => l.snippet === "b" || (l.kind === "name" && l.value === "b"));
	assert.strictEqual(new Set(a.map(l => l.call)).size, 1);
	assert.strictEqual(new Set(b.map(l => l.call)).size, 1);
	assert.notStrictEqual(a[0].call, b[0].call);
});

check("nested calls get distinct call ids", () => {
	const r = scan(`<?php snippet('outer', ['x' => snippet('inner', ['y' => 'z'], true)]);`);
	const outer = r.find(l => l.kind === "name" && l.value === "outer");
	const inner = r.find(l => l.kind === "name" && l.value === "inner");
	assert.notStrictEqual(outer.call, inner.call);
});

check("string after ?: in a value is not a key", () => {
	const r = scan(`<?php snippet('c/b', ['variant' => $x->y() ?: 'filled']);`);
	assert.deepStrictEqual(kinds(r).filter(k => k[0] === "key"), [["key","c/b",null,"variant"]]);
});

check("subscript inside a value is not a key", () => {
	const r = scan(`<?php snippet('c/b', ['icon' => $icon['name']]);`);
	assert.deepStrictEqual(kinds(r).filter(k => k[0] === "key"), [["key","c/b",null,"icon"]]);
});

check("concatenation inside a value is not a key", () => {
	const r = scan(`<?php snippet('c/b', ['label' => $a->value() . ' ' . $b]);`);
	assert.deepStrictEqual(kinds(r).filter(k => k[0] === "key"), [["key","c/b",null,"label"]]);
});

check("ternary inside a value is not a key", () => {
	const r = scan(`<?php snippet('c/b', ['label' => isset($x) ? 'a' : 'b', 'variant' => 'text']);`);
	assert.deepStrictEqual(kinds(r).filter(k => k[0] === "key").map(k => k[3]), ["label", "variant"]);
});

check("keys after an expression value are still keys", () => {
	const r = scan(`<?php snippet('c/b', ['variant' => $x ?: 'filled', 'icon' => 'arrow']);`);
	const v = kinds(r).filter(k => k[0] === "value");
	assert.deepStrictEqual(v, [["value","c/b","icon","arrow"]]);
});

check("nested array literal value keeps its own keys", () => {
	const r = scan(`<?php snippet('c/b', ['attrs' => ['data-x' => 'y'], 'icon' => 'arrow']);`);
	assert.strictEqual(kinds(r).filter(k => k[0] === "value").pop()[3], "arrow");
});

check("heredoc body is not parsed", () => {
	const r = scan(`<?php
$x = <<<HTML
snippet('c/b', ['icon' => 'nope'])
HTML;
snippet('c/b', ['icon' => 'a']);`);
	assert.deepStrictEqual(r.filter(l => l.kind === "value").map(v => v.value), ["a"]);
});

check("nowdoc body is not parsed", () => {
	const r = scan(`<?php
$x = <<<'TXT'
snippet('c/b', ['icon' => 'nope'])
TXT;`);
	assert.deepStrictEqual(r, []);
});

check("interpolated value is not a literal", () => {
	const r = scan(`<?php snippet('c/b', ['icon' => "{$arr['k']}"]);`);
	assert.deepStrictEqual(r.filter(l => l.kind === "value"), []);
});

check("keys nested deeper than the data array are ignored", () => {
	const r = scan(`<?php snippet('c/b', ['x' => ['y' => ['z' => 'deep']], 'icon' => 'a']);`);
	assert.deepStrictEqual(r.filter(l => l.kind === "key").map(k => k.value), ["x", "icon"]);
});

check("match body branches are not values", () => {
	const r = scan(`<?php snippet('c/b', ['icon' => match($x) { 1 => 'a', default => 'b' }]);`);
	assert.deepStrictEqual(r.filter(l => l.kind === "value"), []);
});

check("a numeric key does not inherit the previous key", () => {
	const r = scan(`<?php snippet('c/b', ['icon' => 'a', 0 => 'bad']);`);
	assert.strictEqual(r.filter(l => l.kind === "value" && l.key === "icon").length, 1);
});

check("single-quote escapes are decoded", () => {
	const r = scan(`<?php snippet('c/b', ['label' => 'it\\'s']);`);
	assert.strictEqual(r.find(l => l.kind === "value").value, "it's");
});

check("fallback name array yields one name and no keys", () => {
	const r = scan(`<?php snippet(['c/b', 'other'], ['icon' => 'a']);`);
	assert.deepStrictEqual(r.filter(l => l.kind === "name").map(n => n.value), ["c/b"]);
	assert.deepStrictEqual(r.filter(l => l.kind === "key").map(k => k.value), ["icon"]);
});

check("a snippet call inside a string is not parsed", () => {
	assert.deepStrictEqual(scan(`<?php $s = "snippet('c/b', ['icon' => 'nope'])";`), []);
});

check("a concatenated name is not a name", () => {
	assert.deepStrictEqual(scan(`<?php snippet('tiptap/' . $name);`), []);
});

check("a name concatenated onto is not a name", () => {
	assert.deepStrictEqual(scan(`<?php snippet($page->template()->name() . '/schema');`), []);
});

check("an interpolated name is not a name", () => {
	assert.deepStrictEqual(scan(`<?php snippet("playground/{$component}");`), []);
});

check("a variable name leaves the data array as data", () => {
	const r = scan(`<?php snippet($page->parallax(), ['class' => 'blocks__parallax']);`);
	assert.deepStrictEqual(r.filter(l => l.kind === "name"), []);
	assert.deepStrictEqual(kinds(r), [
		["key", null, null, "class"],
		["value", null, "class", "blocks__parallax"],
	]);
});

check("a variable name still completes its keys against nothing", () => {
	const r = scan(`<?php snippet($x, ['a' => '1', 'b' => '2']);`);
	assert.deepStrictEqual(r.filter(l => l.kind === "key").map(k => k.value), ["a", "b"]);
});

check("a method call carries the variable it sits on", () => {
	const r = scanMethods(`<?php echo $page->headlien();`);
	assert.strictEqual(r[0].receiver.name, "$page");
	assert.strictEqual(`<?php echo $page->headlien();`.slice(r[0].receiver.start, r[0].receiver.end), "$page");
});

check("$this is a receiver like any other", () => {
	assert.strictEqual(scanMethods(`<?php echo $this->og();`)[0].receiver.name, "$this");
});

// Every link answers the value the chain started from. `Kirby\CLI\CLI::__call`
// declares no return type, so asking about `bold()` itself only ever says mixed.
check("every link of a chain answers the base it hangs off", () => {
	const r = scanMethods(`<?php echo $a->b()->c();`);
	assert.strictEqual(r[0].receiver.name, "$a");
	assert.strictEqual(r[1].receiver.name, "$a");
});

check("a property carries the type, not the object holding it", () => {
	const src = `<?php $this->cli->bold()->out();`;
	const r = scanMethods(src);
	assert.deepStrictEqual(r.map((c) => c.receiver.name), ["cli", "cli"]);
	assert.strictEqual(src.slice(r[0].receiver.start, r[0].receiver.end), "cli");
});

check("a base that is not a value yields nothing", () => {
	assert.strictEqual(scanMethods(`<?php Foo::bar()->x();`)[0].receiver, null);
	assert.strictEqual(scanMethods(`<?php helper($a, f($b))->x();`)[0].receiver, null);
});

check("a receiver inside markup is not read", () => {
	assert.deepStrictEqual(scanMethods(`<p>$page->headlien()</p>`), []);
});

check("a fallback list resolves past an entry that is an expression", () => {
	const r = scan(`<?php snippet(["playground/{$component}", 'playground/not-found']);`);
	assert.deepStrictEqual(r.filter(l => l.kind === "name").map(n => n.value), ["playground/not-found"]);
});

check("indented heredoc closer still closes", () => {
	const r = scan(`<?php
$h = <<<HTML
    x
    HTML;
snippet('c/b', ['icon' => 'a']);`);
	assert.deepStrictEqual(r.filter(l => l.kind === "value").map(v => v.value), ["a"]);
});

// Verified against php -l on 8.3: `HTML);` and `HTML,` close, `HTMLisms` does
// not, and body prose starting with the closer word is a parse error in PHP
check("heredoc closer followed by other code on the line closes", () => {
	const src = `<?php f(<<<HTML\nx\nHTML); snippet('c/b', ['icon' => 'a']);`;
	assert.deepStrictEqual(scan(src).filter(l => l.kind === "value").map(v => v.value), ["a"]);
});

check("heredoc closer followed by a comma closes", () => {
	const src = `<?php $a = [<<<HTML\nx\nHTML,\n'y']; snippet('c/b', ['icon' => 'a']);`;
	assert.deepStrictEqual(scan(src).filter(l => l.kind === "value").map(v => v.value), ["a"]);
});

check("indented heredoc closer closes", () => {
	const src = `<?php\n$h = <<<HTML\n    x\n    HTML;\nsnippet('c/b', ['icon' => 'a']);`;
	assert.deepStrictEqual(scan(src).filter(l => l.kind === "value").map(v => v.value), ["a"]);
});

check("closer word as a prefix does not close", () => {
	const src = `<?php\n$h = <<<HTML\nHTMLisms snippet('c/b', ['icon' => 'zz'])\nHTML;\nsnippet('c/b', ['icon' => 'a']);`;
	assert.deepStrictEqual(scan(src).filter(l => l.kind === "value").map(v => v.value), ["a"]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
