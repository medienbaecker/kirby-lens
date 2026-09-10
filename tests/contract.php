<?php

/**
 * Everything this tool reaches for inside Kirby, asserted to still be there.
 *
 * Most of the manifest comes from live registries, so a new tag or field type
 * arrives on its own and a renamed method makes the generator throw loudly. The
 * risk is the quiet half: a registry key that stops being written, a class that
 * moves, a public property that turns private. None of those raise anything.
 * They just make the manifest smaller, and a smaller manifest reads as a
 * project with fewer fields rather than as a broken tool.
 *
 * Run from anywhere inside a Kirby installation, or point it at one:
 * php tests/contract.php [project-root]
 */

use Kirby\Cms\App;
use Medienbaecker\KirbyLens\Manifest;

$index = null;
$bootstrap = null;
$search = isset($argv[1]) === true ? realpath($argv[1]) : getcwd();

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

$kirby = new App(['roots' => ['index' => $index]]);
$constants = (new ReflectionClass(Manifest::class))->getConstants();

$pass = 0;
$fail = 0;

function check(string $name, callable $test): void
{
	global $pass, $fail;

	try {
		$problem = $test();
	} catch (\Throwable $exception) {
		$problem = $exception->getMessage();
	}

	if ($problem === null) {
		$pass++;
		echo "  ok   {$name}\n";
		return;
	}

	$fail++;
	echo "  FAIL {$name}\n       {$problem}\n";
}

echo "  Kirby " . $kirby->version() . "\n";

check('every model class exists', function () use ($constants): string|null {
	$missing = array_filter(
		$constants['MODELS'],
		fn (string $class): bool => class_exists($class) === false
	);

	return $missing === [] ? null : 'gone: ' . implode(', ', $missing);
});

// A key Kirby no longer writes leaves extensions() returning an empty array,
// which is indistinguishable from a project that registered nothing
check('every method registry is one Kirby declares', function () use ($constants): string|null {
	$declared = (new ReflectionClass(\Kirby\Cms\App::class))->getDefaultProperties()['extensions'] ?? null;

	if (is_array($declared) === false) {
		return 'App::$extensions is no longer an array property';
	}

	$unknown = array_filter(
		[...$constants['REGISTRIES'], ...$constants['MODEL_REGISTRIES']],
		fn (string $key): bool => array_key_exists($key, $declared) === false
	);

	return $unknown === [] ? null : 'not declared by Kirby: ' . implode(', ', $unknown);
});

// Kirby 6 declares esc() and bool() outright and drops the registry, so its
// absence is a version and not a breakage. Reading it as one would offer every
// alias as an unknown method.
check('field method aliases are readable where they exist', function (): string|null {
	if (property_exists(\Kirby\Content\Field::class, 'aliases') === false) {
		return trait_exists(\Kirby\Content\FieldMethods::class) === true
			? null
			: 'no Field::$aliases and no FieldMethods trait either';
	}

	return is_array(\Kirby\Content\Field::$aliases) ? null : 'Field::$aliases is not an array';
});

// Read directly because both block registries land in the same extensions key
check('both block method registries are readable as class statics', function (): string|null {
	return is_array(\Kirby\Cms\Block::$methods) && is_array(\Kirby\Cms\Blocks::$methods)
		? null
		: 'Block::$methods or Blocks::$methods is not an array';
});

// Kirby 6 moved these onto a trait, where they are real methods rather than
// closures. Either way the names must arrive camel cased: the extensions copy
// is lowercased, and lowercase labels would be wrong to offer.
check('core field methods keep their camel case', function () use ($kirby): string|null {
	$core = $kirby->core();

	if (method_exists($core, 'fieldMethods') === true) {
		$methods = $core->fieldMethods();

		if (is_array($methods) === false) {
			return 'Core::fieldMethods() no longer returns an array';
		}

		return isset($methods['toStructure']) ? null : 'toStructure is no longer camel cased';
	}

	if (trait_exists(\Kirby\Content\FieldMethods::class) === false) {
		return 'no Core::fieldMethods() and no FieldMethods trait, so the list has no source';
	}

	return method_exists(\Kirby\Content\Field::class, 'toStructure') === true
		? null
		: 'toStructure is not a method on Field';
});

check('a template with no blueprint of its own still resolves', function (): string|null {
	$fields = \Kirby\Cms\Page::factory([
		'slug'     => 'lens-contract',
		'template' => 'lens-no-such-template'
	])->blueprint()->fields();

	// Core registers pages/default unconditionally, which is what lets every
	// template be probed rather than only the ones with a blueprint file
	return is_array($fields) ? null : 'Page::blueprint() no longer falls back';
});

// A field blueprint nothing includes is in no page blueprint, so this is the
// only way its sub-fields are ever seen. Both halves fail quietly: a renamed
// blueprint type answers an empty list, and a find() that stopped resolving
// `extends` answers a blueprint with no fields.
check('a standalone field blueprint is still listed and findable', function () use ($kirby): string|null {
	$names = $kirby->blueprints('fields');

	if (is_array($names) === false) {
		return "blueprints('fields') no longer lists field blueprints";
	}

	if ($names === []) {
		return null;
	}

	$found = \Kirby\Cms\Blueprint::find('fields/' . reset($names));

	return is_array($found) ? null : 'Blueprint::find() no longer answers an array';
});

check('block fieldsets still expand from a plain name list', function () use ($kirby): string|null {
	$fieldsets = \Kirby\Cms\Fieldsets::factory($kirby->blueprints('blocks'));

	return $fieldsets instanceof \Kirby\Cms\Fieldsets
		? null
		: 'Fieldsets::factory() no longer accepts a name list';
});

check('every root the editor half needs is absolute', function () use ($kirby): string|null {
	foreach (['snippets', 'blueprints', 'templates', 'controllers', 'models', 'collections', 'languages', 'index'] as $name) {
		$root = $kirby->root($name);

		if (is_string($root) === false || str_starts_with($root, '/') === false) {
			return "root({$name}) is not an absolute path";
		}
	}

	return null;
});

check('registered snippets and templates carry file paths', function () use ($kirby): string|null {
	foreach (['snippets', 'templates'] as $type) {
		foreach ($kirby->extensions($type) as $name => $path) {
			if (is_string($path) === false) {
				return "extensions({$type}) holds a non-string for {$name}";
			}
		}
	}

	return null;
});

check('translations are readable per language', function () use ($kirby): string|null {
	if (method_exists($kirby, 'translation') === false) {
		return 'App::translation() is gone, and with it the per-language key list';
	}

	$data = $kirby->translation()?->data();

	return is_array($data) ? null : 'Translation::data() no longer returns an array';
});

check('the default language is knowable', function () use ($kirby): string|null {
	// Null on a single-language site, which is fine; the method has to exist
	return method_exists($kirby, 'defaultLanguage')
		? null
		: 'App::defaultLanguage() is gone, and the per-language check has no reference';
});

// A key with a falsy value does not resolve: I18n::translate() tests the
// looked-up value for truth rather than for existence. The manifest filters on
// exactly that, so if this ever changes the filter becomes wrong.
check('a falsy translation value does not resolve', function (): string|null {
	\Kirby\Toolkit\I18n::$translations = ['en' => ['lens.empty' => '', 'lens.real' => 'Yes']];

	$empty = \Kirby\Toolkit\I18n::translate('lens.empty', null, 'en');
	$real  = \Kirby\Toolkit\I18n::translate('lens.real', null, 'en');

	\Kirby\Toolkit\I18n::$translations = [];

	if ($real !== 'Yes') {
		return 'I18n::translate() no longer returns a plain string value';
	}

	return $empty === '' ? 'a falsy value now resolves, so the manifest must stop filtering' : null;
});

// Content::data() is what spares us reimplementing Txt::decode(), whose block
// split is the only thing keeping a structure field's nested YAML keys from
// being harvested as fields of their own
check('content field names arrive already normalised', function (): string|null {
	$data = \Kirby\Data\Txt::decode("Hero-headline: One\n\n----\n\nAnyways:\n\n- sometimes: a\n  but: b");

	if (array_keys($data) !== ['hero_headline', 'anyways']) {
		return 'Txt::decode() no longer folds dashes to underscores, or now splits on nested keys: '
			. implode(', ', array_keys($data));
	}

	return null;
});

check('every model this reads content from still answers', function () use ($kirby): string|null {
	foreach ([[\Kirby\Cms\Site::class, 'index'], [\Kirby\Cms\Page::class, 'intendedTemplate'], [\Kirby\Cms\File::class, 'template'], [\Kirby\Cms\Languages::class, 'codes']] as [$class, $method]) {
		if (method_exists($class, $method) === false) {
			return $class . '::' . $method . '() is gone, and the content scan loses a scope';
		}
	}

	$data = $kirby->site()->content()->data();

	return is_array($data) ? null : 'Content::data() no longer returns an array';
});

check('a missing collection throws rather than returning null', function () use ($kirby): string|null {
	try {
		$kirby->collection('lens-no-such-collection');
	} catch (\Kirby\Exception\NotFoundException) {
		return null;
	} catch (\Throwable $e) {
		return 'collection() now throws ' . $e::class . ' instead of NotFoundException';
	}

	return 'collection() no longer throws, so that diagnostic should be a warning';
});

// A wrapper's named arguments are the snippet's data, and snippet()'s own are
// these. Reading either as the other is what the variadic flag prevents.
check('snippet() still names its own parameters', function (): string|null {
	$expected = ['name', 'data', 'return', 'slots'];
	$actual = array_map(
		fn (\ReflectionParameter $parameter): string => $parameter->getName(),
		(new \ReflectionFunction('snippet'))->getParameters()
	);

	return $actual === $expected
		? null
		: 'snippet() now takes ' . implode(', ', $actual);
});

echo "\n{$pass} passed" . ($fail > 0 ? ", {$fail} failed" : "") . "\n";

exit($fail > 0 ? 1 : 0);
