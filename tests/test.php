<?php

/**
 * Docblock parsing, the part of Kirby Lens that runs in PHP.
 *
 * Run from anywhere inside a Kirby installation, or point it at one:
 * php tests/test.php [project-root]
 */

use Kirby\Filesystem\Dir;
use Kirby\Cms\App;
use Medienbaecker\KirbyLens\Manifest;

$index = null;
$bootstrap = null;
$search = isset($argv[1]) === true ? realpath($argv[1]) : getcwd();

// Resolved from a project root rather than __DIR__, which points into the
// extension rather than at any project
while ($search !== dirname($search)) {
	foreach (['/kirby/bootstrap.php', '/vendor/getkirby/cms/bootstrap.php'] as $candidate) {
		if (is_file($search . $candidate) === true) {
			$index = $search;
			$bootstrap = $search . $candidate;
			break 2;
		}
	}

	$search = dirname($search);
}

if ($index === null) {
	fwrite(STDERR, "No Kirby installation found above " . getcwd() . "\n");
	exit(1);
}

require $bootstrap;
require dirname(__DIR__) . '/php/Type.php';
require dirname(__DIR__) . '/php/Manifest.php';

$dir = sys_get_temp_dir() . '/lens-test-' . getmypid();
Dir::make($dir);
$kirby = new App(['roots' => ['index' => $index, 'snippets' => $dir]]);

$pass = 0;
$fail = 0;

function check(string $name, string $source, array $expected): void
{
	global $dir, $kirby, $pass, $fail;

	file_put_contents($dir . '/probe.php', $source);

	// A manifest indexes the project when it is built, so a probe written after
	// that would not be in it
	$manifest = new Manifest($kirby);

	$actual = array_map(
		fn($param) => $param['type'] . ($param['values'] !== [] ? ' ' . implode(',', $param['values']) : '') . ($param['required'] ? ' !' : ''),
		$manifest->params('probe')
	);

	if ($actual === $expected) {
		$pass++;
		echo "  ok   {$name}\n";
		return;
	}

	$fail++;
	echo "  FAIL {$name}\n       expected " . json_encode($expected) . "\n       actual   " . json_encode($actual) . "\n";
}

check('plain optional', "<?php\n/**\n * @var string|null \$a\n */\n", ['a' => 'string|null']);
check('required has no null', "<?php\n/**\n * @var string \$a\n */\n", ['a' => 'string !']);
check('literal union', "<?php\n/**\n * @var 'x'|'y'|null \$a\n */\n", ['a' => "'x'|'y'|null x,y"]);
check('licence block above the real one', "<?php\n/**\n * Copyright.\n */\n\n/**\n * @var string|null \$a\n */\n", ['a' => 'string|null']);
check('no docblock', "<?php\n\$x = 1;\n", []);
check('spaces around pipes', "<?php\n/**\n * @var string | null \$a\n */\n", ['a' => 'string|null']);
check('description containing a pipe', "<?php\n/**\n * @var string|null \$a Either x|y\n */\n", ['a' => 'string|null']);
check('description containing an arrow', "<?php\n/**\n * @var array \$a Array of ['k' => 'v']\n */\n", ['a' => 'array !']);
check('crlf', "<?php\r\n/**\r\n * @var 'x'|'y'|null \$a\r\n */\r\n", ['a' => "'x'|'y'|null x,y"]);
check('escaped quote inside a literal', "<?php\n/**\n * @var 'it\\'s'|'other'|null \$a\n */\n", ['a' => "'it\\'s'|'other'|null it's,other"]);
check('inline @var later is not merged', "<?php\n/**\n * @var string|null \$a\n */\n\$x = 1;\n/** @var \\Kirby\\Cms\\Page \$p */\n", ['a' => 'string|null']);
check('class type', "<?php\n/**\n * @var \\Kirby\\Cms\\File \$a\n */\n", ['a' => '\\Kirby\\Cms\\File !']);

// No corpus project writes the shorthand, so these are the only cover it has
check('nullable shorthand is optional', "<?php\n/**\n * @var ?string \$a\n */\n", ['a' => '?string']);
check('nullable shorthand keeps its literals', "<?php\n/**\n * @var ?'x'|'y' \$a\n */\n", ['a' => "?'x'|'y' x,y"]);

foreach ([['?string', 'string|null'], ['?bool', 'bool|null'], ['?int', 'int|null']] as [$short, $union]) {
	$name = "{$short} answers as {$union}";
	$a = new Medienbaecker\KirbyLens\Type($short);
	$b = new Medienbaecker\KirbyLens\Type($union);

	if ($a->parts() === $b->parts() && $a->acceptsString() === $b->acceptsString()) {
		$pass++;
		echo "  ok   {$name}\n";
	} else {
		$fail++;
		echo "  FAIL {$name}\n       " . json_encode($a->parts()) . " vs " . json_encode($b->parts()) . "\n";
	}
}

// Injected variables stay in the manifest so a call site passing one is not
// reported as undocumented, but Kirby supplies them so they are never required
check(
	'injected variables are kept but never required',
	"<?php\n/**\n * @var \\Kirby\\Cms\\Page \$page\n * @var string \$a\n */\n",
	['page' => '\\Kirby\\Cms\\Page', 'a' => 'string !']
);
check('a typeless @var is ignored', "<?php\n/**\n * @var \$block\n * @var string|null \$a\n */\n", ['a' => 'string|null']);

// The code is the authority on optionality: real snippets document
// `array $attributes` while doing `$attributes ?? []`
check('?? in the body makes a param optional', "<?php\n/**\n * @var array \$a\n */\n\$a = \$a ?? [];\n", ['a' => 'array']);
check('??= in the body makes a param optional', "<?php\n/**\n * @var string \$a\n */\n\$a ??= 'x';\n", ['a' => 'string']);
check('?: in the body makes a param optional', "<?php\n/**\n * @var string \$a\n */\n\$a = \$a ?: 'x';\n", ['a' => 'string']);
check('no fallback keeps it required', "<?php\n/**\n * @var string \$a\n */\necho \$a;\n", ['a' => 'string !']);

// Twice as many real snippets declare parameters in code as in a docblock, so
// they are read either way. The type is guessed from the default, and the list
// is a floor rather than a signature, which analyze.js accounts for
check('??= declares a parameter', "<?php\n\$a ??= 'x';\n", ['a' => 'string']);
check('$a = $a ?? declares a parameter', "<?php\n\$a = \$a ?? [];\n", ['a' => 'array']);
check('a parenthesised fallback still counts', "<?php\n\$a = (\$a ?? false) || \$b;\n", ['a' => 'bool']);
check('?: declares a parameter', "<?php\n\$a = \$a ?: 3;\n", ['a' => 'int']);
check('an unrecognisable default stays mixed', "<?php\n\$a ??= \$page->title();\n", ['a' => 'mixed']);
check('injected names are never inferred', "<?php\n\$page ??= null;\n\$a ??= 'x';\n", ['a' => 'string']);
check(
	'a docblock wins over the code',
	"<?php\n/**\n * @var 'x'|'y'|null \$a\n */\n\$a ??= 'x';\n",
	['a' => "'x'|'y'|null x,y"]
);
check(
	'documented and inferred parameters merge',
	"<?php\n/**\n * @var string|null \$a\n */\n\$b ??= 'x';\n",
	['a' => 'string|null', 'b' => 'string']
);

// Composer's `scrivo/highlight.php` is a package, so a real project can hold a
// directory that passes an extension check and then dies on the read
Dir::make($dir . '/highlight.php');
file_put_contents($dir . '/highlight.php/inner.php', "<?php\n");

$name = 'a directory named like a PHP file is not a snippet';

try {
	$snippets = (new Manifest($kirby))->snippets();
	$problem = in_array('highlight', $snippets, true) === true
		? 'listed the directory as a snippet'
		: null;
} catch (\Throwable $exception) {
	$problem = $exception->getMessage();
}

if ($problem === null) {
	$pass++;
	echo "  ok   {$name}\n";
} else {
	$fail++;
	echo "  FAIL {$name}\n       {$problem}\n";
}

Dir::remove($dir);

$project = sys_get_temp_dir() . '/lens-wrappers-' . getmypid();
Dir::make($project . '/site/config');

file_put_contents($project . '/site/config/helpers.php', <<<'PHP'
<?php
function lensShort($name, ...$data) {
	return snippet($name, data: $data, return: true);
}
function lensLong($name, $data = []) {
	return snippet($name, $data, true);
}
function lensPicksItsOwn($label, ...$rest) {
	return snippet('components/card', $rest);
}
function lensRendersNothing($text, ...$filter) {
	return strtoupper($text);
}
PHP);

require $project . '/site/config/helpers.php';

$wrappers = (new Manifest(new App(['roots' => ['index' => $project]])))->functions();

$verify = function (string $name, bool $ok) use (&$pass, &$fail): void {
	if ($ok === true) {
		$pass++;
		echo "  ok   {$name}\n";
		return;
	}

	$fail++;
	echo "  FAIL {$name}\n";
};

$verify('finds a wrapper that hands its first parameter to snippet()',
	array_key_exists('lensShort', $wrappers));

$verify('a wrapper collecting named arguments carries its data in them',
	($wrappers['lensShort'] ?? null) === true);

$verify('a wrapper taking a data array does not',
	($wrappers['lensLong'] ?? null) === false);

$verify('a function that renders a snippet of its own choosing is not a wrapper',
	array_key_exists('lensPicksItsOwn', $wrappers) === false);

$verify('a variadic function that never reaches snippet() is not a wrapper',
	array_key_exists('lensRendersNothing', $wrappers) === false);

$verify('snippet itself is always a caller', ($wrappers['snippet'] ?? null) === false);

$verify('a wrapper keeps the case it was declared with',
	array_key_exists('lensShort', $wrappers) === true &&
	array_key_exists('lensshort', $wrappers) === false);

Dir::remove($project);

echo "\n{$pass} passed, {$fail} failed\n";
exit($fail > 0 ? 1 : 0);
