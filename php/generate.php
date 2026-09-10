<?php

/**
 * Writes the manifest for a Kirby project. Shipped inside the extension and run
 * against the project, so nothing has to be installed into the project itself.
 *
 * The project's own Kirby is booted, which is the whole point: plugin-registered
 * blueprints, tags, translations and field types only exist at runtime.
 *
 * php generate.php <project-root> <out-path>
 */

use Kirby\Cms\App;
use Medienbaecker\KirbyLens\Manifest;

[$root, $out] = [$argv[1] ?? null, $argv[2] ?? null];

if ($root === null || $out === null) {
	fwrite(STDERR, "usage: php generate.php <project-root> <out-path>\n");
	exit(1);
}

if (($root = realpath($root)) === false) {
	fwrite(STDERR, "No such directory: {$argv[1]}\n");
	exit(1);
}

$bootstrap = match (true) {
	is_file($root . '/kirby/bootstrap.php')               => $root . '/kirby/bootstrap.php',
	is_file($root . '/vendor/getkirby/cms/bootstrap.php') => $root . '/vendor/getkirby/cms/bootstrap.php',
	default                                               => null
};

if ($bootstrap === null) {
	fwrite(STDERR, "Not a Kirby project: no Kirby found in {$root}\n");
	exit(2);
}

// Rendering would run the project's routes, and a CLI has no request to serve
$_ENV['KIRBY_RENDER'] = false;

// The way a project's index.php loads it: a Composer install registers Kirby
// through this, and a config reaching for the project's own classes needs it
if (is_file($autoload = $root . '/vendor/autoload.php') === true) {
	require_once $autoload;
}

require $bootstrap;

// bootstrap.php prefers a site-wide autoloader and then stops, so a project
// whose Composer setup knows nothing about Kirby never loads Kirby's own
if (class_exists(App::class) === false) {
	$own = dirname($bootstrap) . '/vendor/autoload.php';

	if (is_file($own) === true) {
		require_once $own;
	}
}

if (class_exists(App::class) === false) {
	fwrite(STDERR, "Kirby did not load from {$bootstrap}\n");
	fwrite(STDERR, "Nothing here registers Kirby\\Cms\\App. Run composer install, or check that a downloaded kirby/ still has its vendor directory.\n");
	exit(2);
}

require __DIR__ . '/Type.php';
require __DIR__ . '/Manifest.php';

echo (new Manifest(new App(['roots' => ['index' => $root]])))->write($out) . PHP_EOL;
