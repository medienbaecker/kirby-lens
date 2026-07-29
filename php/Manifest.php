<?php

namespace Medienbaecker\KirbyLens;

use Kirby\Cms\App;
use Kirby\Filesystem\Dir;
use Kirby\Data\Yaml;
use Kirby\Filesystem\F;

/**
 * Reads the `@var` docblocks of every snippet and writes what the editor
 * extension needs to complete and check `snippet()` calls.
 */
final readonly class Manifest
{
	// Rendered from their own controllers, so they are marked rather than
	// offered. Dropping them instead cost cmd-click and checking on the ones
	// that do get called by hand.
	// `medienbaecker.kirby-lens.ignore` replaces this list.
	private const IGNORED = [
		'#^blocks/#',
		'#^modules/#',
		'#^playground/#'
	];

	/**
	 * Names Kirby supplies itself, so passing one is not an undocumented key.
	 */
	private const INJECTED = [
		'page',
		'site',
		'pages',
		'kirby',
		'block',
		'item',
		'slot',
		'slots'
	];

	/** @var array<string, string> Snippet name mapped to the file that renders it */
	private array $files;

	public function __construct(private App $kirby)
	{
		$this->files = $this->index();
	}

	public function path(): string
	{
		return $this->kirby->root('cache') . '/lens/manifest.json';
	}

	public function write(string|null $path = null): string
	{
		$path ??= $this->path();

		// Written beside the target and moved into place. The editor watches
		// this file, and a rewrite in place gives it a window in which to read
		// half a document. Named per process, because two generators racing on
		// one temporary file would rename each other's half-written output.
		F::write($temporary = $path . '.' . getmypid() . '.tmp', $this->toJson());
		rename($temporary, $path);

		return $path;
	}

	public function toJson(): string
	{
		$snippets = [];
		$content = $this->content();

		foreach ($this->snippets() as $snippet) {
			$snippets[$snippet] = [
				// A plugin-registered snippet lives nowhere near the snippets
				// root, so its name alone will not find it again
				'file'    => $this->relative($this->files[$snippet]),
				'ignored' => $this->isIgnored($snippet),
				'summary' => $this->summary($snippet),
				'params'  => $this->params($snippet)
			];
		}

		return json_encode(
			[
				// What this manifest was read out of, so a report about wrong
				// completions says which Kirby produced them
				'kirby'    => $this->kirby->version(),
				'roots'    => $this->roots(),
				'packages' => $this->packages(),
				'snippets' => $snippets,
				'translations' => $this->translations(),
				'collections'  => $this->collections(),
				'fields'   => $this->fields(),
				'fieldsets' => $this->fieldsets(),
				'content'  => $content['scopes'],
				'structures' => $content['structures'],
				'models'   => $this->models(),
				'methods'  => $this->methods(),
				'fieldMethods' => $this->fieldMethods(),
				'fieldTypes'   => $this->fieldTypes()
			],
			JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
		) . "\n";
	}

	/**
	 * Model classes whose methods a template might call. Everything is
	 * lowercased, because PHP method names are case-insensitive and
	 * Content::get() lowercases field names too.
	 */
	private const MODELS = [
		\Kirby\Cms\App::class,
		\Kirby\Cms\Page::class,
		\Kirby\Cms\Pages::class,
		\Kirby\Cms\Site::class,
		\Kirby\Cms\File::class,
		\Kirby\Cms\Files::class,
		\Kirby\Cms\User::class,
		\Kirby\Cms\Users::class,
		\Kirby\Cms\Block::class,
		\Kirby\Cms\Blocks::class,
		\Kirby\Cms\Collection::class,
		\Kirby\Cms\Layout::class,
		\Kirby\Cms\LayoutColumn::class,
		\Kirby\Cms\Layouts::class,
		\Kirby\Cms\Language::class,
		\Kirby\Cms\Languages::class,
		\Kirby\Cms\Structure::class,
		\Kirby\Cms\StructureObject::class,
		\Kirby\Cms\Pagination::class,
		\Kirby\Content\Field::class,
		// Reached through `$page->blueprint()` and `$page->content()`, both of
		// which templates and models call as a matter of course
		\Kirby\Cms\Blueprint::class,
		\Kirby\Content\Content::class,
		// File::__call proxies to the asset, so width() and height() are here
		\Kirby\Cms\FileVersion::class,
		\Kirby\Filesystem\Asset::class,
		\Kirby\Image\Image::class
	];

	/**
	 * The method registries a plugin can extend. Kirby's own list, so a renamed
	 * key here would silently stop reaching plugin methods; tests/contract.php
	 * checks these against the ones Kirby declares.
	 */
	private const REGISTRIES = [
		'pageMethods', 'pagesMethods', 'siteMethods', 'fileMethods',
		'filesMethods', 'userMethods', 'usersMethods', 'fieldMethods',
		'layoutMethods', 'layoutsMethods', 'layoutColumnMethods',
		'structureMethods', 'structureObjectMethods', 'collectionMethods',
		'assetMethods'
	];

	/**
	 * The model registries whose classes a project writes itself.
	 */
	private const MODEL_REGISTRIES = ['pageModels', 'userModels', 'blockModels'];

	/**
	 * Blueprint names mapped to their resolved field names, `extends` and plugin
	 * mixins included, plus a union across all of them.
	 *
	 * The union is what makes a diagnostic possible without resolving which
	 * blueprint applies to the file being edited: a name in no blueprint at all
	 * is wrong wherever it appears.
	 */
	public function fields(): array
	{
		$blueprints = [];

		foreach ($this->probes() as $name => $fields) {
			$blueprints[$name] = $this->flatten($fields);
		}

		ksort($blueprints);

		$union = array_merge(...array_values($blueprints) ?: [[]]);
		ksort($union);

		// An empty PHP array encodes as `[]`, which the editor half cannot tell
		// from the old list-of-names shape
		return [
			'blueprints' => array_map(fn (array $fields): object => (object) $fields, $blueprints),
			'union'      => (object) $union
		];
	}

	/**
	 * The top-level field names of each block fieldset, deliberately unflattened.
	 *
	 * A block label is resolved against exactly this list, and `fields()` lifts a
	 * structure's children up to the same level, which would be wrong here.
	 */
	public function fieldsets(): array
	{
		$found = [];

		$fieldsets = $this->resolve(
			fn () => \Kirby\Cms\Fieldsets::factory($this->kirby->blueprints('blocks'))
		);

		foreach ($fieldsets ?: [] as $fieldset) {
			$names = array_map(
				fn ($name): string => strtolower((string) $name),
				array_keys($this->resolve(fn () => $fieldset->fields()))
			);

			sort($names);
			$found[$fieldset->type()] = $names;
		}

		ksort($found);

		return $found;
	}

	/**
	 * Field names that exist in content files, whether or not a blueprint
	 * declares them.
	 *
	 * A project run without the Panel keeps its whole schema here. Names come
	 * from Content::data() rather than a scan, because Txt::decode() is what
	 * normalises them and what keeps a structure's nested YAML keys out.
	 *
	 * Those nested keys come back separately, under `structures`, because they
	 * are reachable only on a structure item. Folding them into a scope would
	 * offer `$page->icon()`, and `contentFields()` flattens every scope when a
	 * file has no blueprint, so a panel-less project would offer them everywhere.
	 *
	 * @return array{scopes: array, structures: array}
	 */
	public function content(): array
	{
		$found = [];
		$nested = [];

		// A key defined only in a translation is still a key, and the default
		// language's file is not guaranteed to carry every one
		$languages = $this->kirby->languages()->codes() ?: [null];

		$declared = $this->structural();

		$collect = function (string $scope, $model) use (&$found, &$nested, $declared, $languages): void {
			foreach ($languages as $language) {
				foreach ($this->resolve(fn () => $model->content($language)->data()) as $name => $value) {
					$found[$scope][strtolower((string) $name)] = 'field';

					if (isset($declared[strtolower((string) $name)]) === true) {
						$this->nested($value, $nested);
					}

					// A blocks field is JSON, and a structure inside a block is
					// nested in it rather than stored as YAML of its own
					if (is_string($value) === true && str_starts_with(ltrim($value), '[') === true) {
						$decoded = json_decode($value, true);

						if (is_array($decoded) === true) {
							$this->descend($decoded, $declared, $nested);
						}
					}
				}
			}
		};

		$files = function ($parent) use ($collect): void {
			foreach ($this->resolve(fn () => $parent->files()) as $file) {
				$collect('files/' . ($file->template() ?? 'default'), $file);
			}
		};

		$site = $this->kirby->site();

		$collect('site', $site);
		$files($site);

		// Drafts included: an unpublished page renders in the Panel preview and
		// its fields are as real as any other page's
		foreach ($this->resolve(fn () => $site->index(true)) as $page) {
			$collect('pages/' . $page->intendedTemplate()->name(), $page);
			$files($page);
		}

		foreach ($found as &$names) {
			ksort($names);
		}

		unset($names);
		ksort($found);
		ksort($nested);

		return ['scopes' => $found, 'structures' => $nested];
	}

	/**
	 * Field names the project's own code treats as carrying named sub-keys.
	 *
	 * Kirby never infers this. A content value becomes a structure only because
	 * something calls `toStructure()` on it, which is `Data::decode(…, 'yaml')`
	 * (`config/methods.php:274`); `yaml()` and `toData()` reach the same decoder
	 * and `toObject()` the same shape. So the call is the declaration.
	 *
	 * Reading the content instead cannot work, and not for want of a cleverer
	 * test: one Medienbaecker article is a markdown list *about* YAML, so it is
	 * a genuine list of maps and contributed `and`, `but` and `sometimes` as
	 * field names. Requiring uniform keys per row rejects that and also rejects
	 * the real structure beside it, which is hand-written and carries `footer`
	 * on its first row only. Panel-less content is not uniform.
	 */
	private function structural(): array
	{
		$found = [];

		foreach (['snippets', 'templates', 'controllers', 'models'] as $key) {
			$dir = $this->kirby->root($key);

			if (is_dir($dir) === false) {
				continue;
			}

			foreach (Dir::index($dir, true) as $path) {
				$file = $dir . '/' . $path;

				if (F::extension($file) !== 'php') {
					continue;
				}

				preg_match_all(
					'#->\s*([a-zA-Z_]\w*)\s*\(\s*\)\s*->\s*(?:toStructure|toObject|toEntries|yaml|toData)\s*\(#',
					(string) F::read($file),
					$matches
				);

				foreach ($matches[1] as $name) {
					$found[strtolower($name)] = true;
				}
			}
		}

		return $found;
	}

	/**
	 * The sub-field names inside one declared structure's value.
	 */
	private function nested(mixed $value, array &$found): void
	{
		// Inside a block the structure is stored already decoded, as real JSON
		$rows = is_array($value) === true ? $value : $this->yaml($value);

		if (is_array($rows) === false || $rows === [] || array_is_list($rows) === false) {
			return;
		}

		foreach ($rows as $row) {
			if (is_array($row) === false || array_is_list($row) === true) {
				return;
			}

			foreach (array_keys($row) as $name) {
				$found[strtolower((string) $name)] = 'field';
			}
		}
	}

	private function yaml(mixed $value): array|null
	{
		if (is_string($value) === false || str_contains($value, ':') === false) {
			return null;
		}

		try {
			return Yaml::decode($value);
		} catch (\Throwable) {
			return null;
		}
	}

	/**
	 * Every declared structure reachable inside a decoded blocks payload.
	 *
	 * A blocks field is JSON, and a structure inside a block is nested in that
	 * JSON rather than stored as YAML, so `$block->pins()->toStructure()` is
	 * reachable only by descending. One project's `pins` is a plugin field type
	 * with no `fields:` in its blueprint, so nothing else declares `x` and `y`.
	 */
	private function descend(array $data, array $declared, array &$found): void
	{
		foreach ($data as $key => $value) {
			if (is_string($key) === true && isset($declared[strtolower($key)]) === true) {
				$this->nested($value, $found);
			}

			if (is_array($value) === true) {
				$this->descend($value, $declared, $found);
			}
		}
	}

	/**
	 * Field names at every depth. A structure or object nests them under
	 * `fields`, a blocks field under `fieldsets`, a layout under `columns`, and
	 * `$item->button_label()` inside a loop reads exactly like a top-level call.
	 */
	private function flatten(array $fields): array
	{
		$found = [];

		foreach ($fields as $name => $field) {
			// `fieldsets:` and `sections:` are often plain lists, which iterate
			// with integer keys. Skip the name, never the descent below it.
			if (is_int($name) === false) {
				$found[strtolower((string) $name)] = is_array($field)
					? (string) ($field['type'] ?? 'field')
					: 'field';
			}

			if (is_array($field) === false) {
				continue;
			}

			foreach (['fields', 'fieldsets', 'columns', 'tabs', 'sections'] as $key) {
				if (is_array($field[$key] ?? null) === true) {
					$found = [...$this->flatten($field[$key]), ...$found];
				}
			}
		}

		return $found;
	}

	/**
	 * Field definitions per blueprint. A page blueprint only resolves relative
	 * to a model, so each one gets a throwaway page, file or user.
	 */
	private function probes(): \Generator
	{
		yield 'site' => $this->resolve(fn () => $this->kirby->site()->blueprint()->fields());

		foreach ($this->templates() as $name) {
			yield 'pages/' . $name => $this->resolve(
				fn () => \Kirby\Cms\Page::factory([
					'slug'     => 'lens',
					'template' => $name,
					'model'    => $name
				])->blueprint()->fields()
			);
		}

		foreach ($this->kirby->blueprints('files') as $name) {
			yield 'files/' . $name => $this->resolve(
				fn () => \Kirby\Cms\File::factory([
					'filename' => 'lens.jpg',
					'template' => $name,
					'parent'   => $this->kirby->site()
				])->blueprint()->fields()
			);
		}

		foreach ($this->kirby->blueprints('users') as $name) {
			yield 'users/' . $name => $this->resolve(
				fn () => \Kirby\Cms\User::factory(['model' => $name])->blueprint()->fields()
			);
		}

		// Blocks are not models and have no blueprint(); their fields live in the
		// fieldset registry. `$block->mode()` reads like any other field call,
		// but a page blueprint never resolves its blocks field down this far.
		$fieldsets = $this->resolve(
			fn () => \Kirby\Cms\Fieldsets::factory($this->kirby->blueprints('blocks'))
		);

		foreach ($fieldsets ?: [] as $fieldset) {
			yield 'blocks/' . $fieldset->type() => $this->resolve(fn () => $fieldset->fields());
		}
	}

	/**
	 * Every template a page in this project could have.
	 *
	 * Templates rather than blueprints, because a template without a blueprint
	 * of its own still renders: Page::blueprint() falls back to `pages/default`,
	 * which Core::blueprints() registers unconditionally and so always resolves.
	 * Probing blueprint names alone leaves those templates with no fields at all.
	 *
	 * There is no App::templates() to ask, only App::blueprints(), so this is
	 * that method's glob-and-merge done by hand.
	 */
	private function templates(): array
	{
		$names = [];
		$root = $this->kirby->root('templates');

		foreach (Dir::index($root, true) as $path) {
			if (F::extension($path) !== 'php') {
				continue;
			}

			// A representation sits beside its template as `feed.rss.php` and is
			// not a template in its own right
			$name = substr($path, 0, -4);
			$names[] = strstr($name, '.', true) ?: $name;
		}

		foreach ($this->kirby->extensions('templates') as $name => $path) {
			// Kirby registers its own two auth email templates here, and no page
			// ever has one
			if (is_string($path) && str_starts_with($path, $this->kirby->root('kirby')) === false) {
				$names[] = $name;
			}
		}

		return array_unique([...$names, ...$this->kirby->blueprints('pages')]);
	}

	/**
	 * A blueprint that cannot be built tells us nothing, and one bad file must
	 * not cost the whole manifest.
	 */
	private function resolve(callable $get)
	{
		try {
			return $get();
		} catch (\Throwable) {
			return [];
		}
	}

	/**
	 * Every class a `->field()` call may legitimately sit on.
	 *
	 * The editor resolves a receiver's type through the language server and asks
	 * whether it is one of these. A class that is none of them is not reaching
	 * for a field at all, which is how `$cli->arg()` stops being reported. The
	 * project's own models are included because they read exactly like a Page at
	 * a call site.
	 */
	public function models(): array
	{
		$found = self::MODELS;

		foreach (self::MODEL_REGISTRIES as $type) {
			foreach ($this->kirby->extensions($type) as $class) {
				if (is_string($class) === true && class_exists($class) === true) {
					$found[] = $class;
				}
			}
		}

		$found = array_values(array_unique($found));
		sort($found);

		return $found;
	}

	/**
	 * Every method a call site could legitimately be reaching for: Kirby's own,
	 * every field method, and everything the project's plugins registered.
	 *
	 * Without this a field diagnostic would flag `$page->children()`.
	 */
	public function methods(): array
	{
		$methods = [];

		foreach (self::MODELS as $class) {
			$methods = [...$methods, ...get_class_methods($class)];
		}

		foreach (self::REGISTRIES as $type) {
			$methods = [...$methods, ...array_keys($this->kirby->extensions($type))];
		}

		// Both block registries write into the `blockMethods` key, so whichever
		// Kirby extends second clobbers the other and the extensions array can
		// never hold both. The class statics are correct.
		// AppPlugins::extendBlocksMethods(), Kirby 5.5.0
		$methods = [
			...$methods,
			...array_keys(\Kirby\Cms\Block::$methods),
			...array_keys(\Kirby\Cms\Blocks::$methods)
		];

		// PHP's own classes. A template doing `$date->format(...)` on a DateTime
		// is not reaching for a field, and nothing else here would know that.
		// Internal means defined by PHP itself rather than by userland, so this
		// stays out of Kirby's and the project's business.
		foreach (get_declared_classes() as $class) {
			if ((new \ReflectionClass($class))->isInternal() === true) {
				$methods = [...$methods, ...get_class_methods($class)];
			}
		}

		// A project's own model methods read exactly like fields at a call site.
		// Every one of these classes is already loaded by the time we get here:
		// extensionsFromFolders() requires the file before registering the class.
		foreach (self::MODEL_REGISTRIES as $type) {
			foreach ($this->kirby->extensions($type) as $class) {
				if (is_string($class) === true && class_exists($class) === true) {
					$methods = [...$methods, ...get_class_methods($class)];
				}
			}
		}

		// Field method aliases are a separate registry from the methods, and are
		// fully documented API: `esc` for `escape`, `bool` for `toBool`
		$methods = [...$methods, ...array_keys(\Kirby\Content\Field::$aliases)];

		// Whatever the registries above still cannot reach: a helper function, a
		// plugin class Composer autoloads only when first used, an anonymous
		// class returned by a pageMethod. Removing this costs 14 false positives
		// across the corpus, so it stays.
		$methods = [...$methods, ...$this->declared()];

		// Kirby writes these into content files itself, so they are real fields
		// that appear in no blueprint
		$methods = [...$methods, 'uuid', 'focus', 'sort'];

		$methods = array_values(array_unique(array_map('strtolower', $methods)));
		sort($methods);

		return $methods;
	}

	/**
	 * Every function name the project's own PHP declares, wherever it lives.
	 *
	 * Deliberately broad: a name that exists anywhere in the project is not
	 * evidence of a typo, and a false negative here costs nothing while a false
	 * positive costs trust.
	 */
	private function declared(): array
	{
		$names = [];

		foreach (['site', 'plugins'] as $dir) {
			$root = $this->kirby->root('index') . '/' . $dir;

			if (is_dir($root) === false) {
				continue;
			}

			foreach (Dir::index($root, true) as $path) {
				if (F::extension($path) !== 'php') {
					continue;
				}

				preg_match_all(
					'#\bfunction\s+&?(\w+)\s*\(#',
					F::read($root . '/' . $path) ?: '',
					$matches
				);

				$names = [...$names, ...$matches[1]];
			}
		}

		return $names;
	}

	/**
	 * Field methods on their own, separate from the union used for diagnostics,
	 * because these are the only things worth offering after `$page->field()->`.
	 *
	 * Aliases included: `esc` and `escape` are both real to a call site.
	 */
	public function fieldMethods(): array
	{
		// core()->fieldMethods() keeps the camelCase from config/methods.php;
		// Field::$methods is the same list lowercased for case-insensitive
		// dispatch, and lowercase labels would be wrong to offer
		$methods = [];
		$lower = [];

		foreach ($this->kirby->core()->fieldMethods() as $name => $callback) {
			$methods[$name] = $lower[strtolower($name)] = $this->arity($callback);
		}

		// Kirby lowercases the registered copy, so anything already known by
		// name would come back a second time in the wrong case
		foreach ($this->kirby->extensions('fieldMethods') as $name => $callback) {
			if (isset($lower[strtolower($name)]) === true) {
				continue;
			}

			$methods[$name] = $lower[strtolower($name)] = $this->arity($callback);
		}

		// An alias takes whatever its target takes, unless the name is already a
		// method in its own right: `excerpt` is both, and aliases `toExcerpt`
		foreach (\Kirby\Content\Field::$aliases as $alias => $target) {
			if (isset($methods[$alias]) === true) {
				continue;
			}

			$methods[$alias] = $lower[strtolower($target)] ?? 0;
		}

		ksort($methods);

		return $methods;
	}

	/**
	 * How many arguments a field method takes from the call site, which decides
	 * whether completing it should leave the cursor inside the parentheses.
	 *
	 * The first parameter is always the field itself, so it does not count.
	 */
	private function arity(mixed $callback): int
	{
		try {
			$count = (new \ReflectionFunction(\Closure::fromCallable($callback)))
				->getNumberOfParameters();
		} catch (\Throwable) {
			return 0;
		}

		return max(0, $count - 1);
	}

	/**
	 * Every blueprint field type, core and plugin-registered. Used to check the
	 * editor's field-type table against what this Kirby actually has.
	 */
	public function fieldTypes(): array
	{
		$types = array_keys($this->kirby->extensions('fields'));
		sort($types);

		return $types;
	}

	/**
	 * Every snippet name this project can render.
	 */
	public function snippets(): array
	{
		return array_keys($this->files);
	}

	/**
	 * Snippet names mapped to their files.
	 *
	 * A directory listing alone misses every snippet a plugin registers, and
	 * those are as callable as any other. Snippet::file() looks on disk before
	 * the registry, so a file of the same name wins.
	 */
	private function index(): array
	{
		$files = [];

		foreach ($this->kirby->extensions('snippets') as $name => $path) {
			if (is_string($path) === true) {
				$files[$name] = $path;
			}
		}

		$root = $this->kirby->root('snippets');

		foreach (Dir::index($root, true) as $path) {
			if (F::extension($path) === 'php') {
				$files[substr($path, 0, -4)] = $root . '/' . $path;
			}
		}

		ksort($files);

		return $files;
	}

	/**
	 * Where this project keeps what the editor half resolves against. Every
	 * root is configurable in index.php, so nothing may assume `site/`.
	 *
	 * Relative to the index root where it sits inside it, because the editor
	 * works in paths relative to the workspace folder.
	 */
	public function roots(): array
	{
		$roots = [];

		foreach (
			['snippets', 'blueprints', 'templates', 'controllers', 'models', 'collections', 'languages', 'plugins']
			as $name
		) {
			$roots[$name] = $this->relative($this->kirby->root($name));
		}

		return $roots;
	}

	/**
	 * Plugins that are packages rather than code written for this project.
	 *
	 * The checks read a file as if the author could fix it. A vendored plugin is
	 * the clearest case where that is false, but the directory is the wrong axis
	 * on its own: skipping all of `site/plugins` also skips the `site` and
	 * `methods` plugins a project writes for itself, where the findings are real.
	 * Measured across the corpus, `composer.json` splits it 1,573 to 341.
	 */
	public function packages(): array
	{
		$root = $this->kirby->root('plugins');
		$found = [];

		foreach (Dir::dirs($root ?? '') as $name) {
			if (is_file($root . '/' . $name . '/composer.json') === true) {
				$found[] = $this->relative($root . '/' . $name);
			}
		}

		sort($found);

		return $found;
	}

	/**
	 * Every translation key this project can resolve, and which languages
	 * define which of its own.
	 *
	 * `resolvable` is the union across languages, because a key defined only in
	 * German still resolves when German is the active one. `project` is read
	 * from the language files directly rather than from the merged set: Kirby
	 * ships incomplete Panel translations for plenty of locales, and comparing
	 * merged sets reports hundreds of keys that are Kirby's business, not the
	 * project's.
	 */
	public function translations(): array
	{
		$resolvable = [];
		$project    = [];
		$files      = [];

		// Kirby's own keys are reachable from t() in a template, not just in
		// the Panel, so a call using one is correct
		$core = $this->kirby->root('kirby') . '/i18n/translations/en.json';

		if (is_file($core) === true) {
			// A falsy value does not resolve: I18n::translate() tests the
			// looked-up value for truth, not for existence, and falls through
			$resolvable = array_keys(array_filter(json_decode(F::read($core) ?: '{}', true) ?? []));
			$shipped = array_flip($resolvable);
		}

		foreach ($this->kirby->languages() as $language) {
			$data = $this->resolve(
				fn () => $this->kirby->translation($language->code())?->data() ?? []
			);

			$resolvable = [...$resolvable, ...array_keys(array_filter($data))];
		}

		// A single-language site has no languages() at all
		if (count($this->kirby->languages()) === 0) {
			$data = $this->resolve(fn () => $this->kirby->translation()?->data() ?? []);
			$resolvable = [...$resolvable, ...array_keys(array_filter($data))];
		}

		$root = $this->kirby->root('languages');

		foreach (Dir::index($root) as $file) {
			if (F::extension($file) !== 'php') {
				continue;
			}

			$data = $this->resolve(fn () => require $root . '/' . $file);

			// Kirby reads the code out of the file's own array and only falls
			// back to the filename: `$props['code'] ??= F::name($file)` in
			// Languages::load(). The two are almost always the same, and the
			// mapping is wrong wherever they are not.
			$code = is_array($data) && is_string($data['code'] ?? null)
				? $data['code']
				: substr($file, 0, -4);

			$project[$code] = array_keys(
				array_filter(is_array($data['translations'] ?? null) ? $data['translations'] : [])
			);

			$files[$code] = $this->relative($root . '/' . $file);
			$resolvable   = [...$resolvable, ...$project[$code]];
		}

		$resolvable = array_values(array_unique($resolvable));
		sort($resolvable);
		ksort($project);

		// The strings themselves, for the default language, so a call site can
		// show what it resolves to. Truncated, because a preview is a glance and
		// some translations are paragraphs.
		//
		// Kirby's own ~730 Panel strings are left out: nobody hovers `t('add')`
		// in a template to find out it says Add, and carrying them tripled the
		// size of the whole manifest.
		$preview = [];
		$shipped ??= [];

		foreach ($this->resolve(fn () => $this->kirby->translation()?->data() ?? []) as $key => $value) {
			if (is_string($value) === true && $value !== '' && isset($shipped[$key]) === false) {
				$preview[$key] = mb_strimwidth($value, 0, 80, '…');
			}
		}

		return [
			// What the per-language check compares against
			'default'    => $this->kirby->defaultLanguage()?->code(),
			'preview'    => $preview,
			'resolvable' => $resolvable,
			'project'    => $project,
			'files'      => $files
		];
	}

	/**
	 * Every collection this project can load. Unlike most of what fails
	 * silently here, `collection()` throws when the name does not resolve.
	 */
	public function collections(): array
	{
		$names = array_keys($this->kirby->extensions('collections'));
		$root  = $this->kirby->root('collections');

		foreach (Dir::index($root, true) as $path) {
			if (F::extension($path) === 'php') {
				$names[] = substr($path, 0, -4);
			}
		}

		$names = array_values(array_unique($names));
		sort($names);

		return $names;
	}

	/**
	 * A path relative to the index root, left absolute if it sits outside it.
	 */
	private function relative(string $path): string
	{
		$index = $this->kirby->root('index') . '/';

		return str_starts_with($path, $index) ? substr($path, strlen($index)) : $path;
	}

	public function params(string $snippet): array
	{
		$source = $this->source($snippet);
		$params = $this->documented($source);

		// Twice as many real snippets declare their parameters with `??=` as
		// with a docblock, so a snippet is worth completing either way
		foreach ($this->inferred($source) as $name => $param) {
			$params[$name] ??= $param;
		}

		return $params;
	}

	/**
	 * The prose above the first tag in the docblock. Most real snippets open
	 * with a line like "Image Card Component", which is the single most useful
	 * thing to show when hovering the name.
	 */
	public function summary(string $snippet): string
	{
		$docblock = $this->docblock($this->source($snippet));

		if ($docblock === null) {
			return '';
		}

		$lines = [];

		foreach (explode("\n", $docblock) as $line) {
			$line = trim(preg_replace('#^\s*\*\s?#', '', $line));

			if (str_starts_with($line, '@') === true) {
				break;
			}

			$lines[] = $line;
		}

		return trim(implode(' ', array_filter($lines)));
	}

	private function documented(string $source): array
	{
		$docblock = $this->docblock($source);

		if ($docblock === null) {
			return [];
		}

		// Lazy type so it stops at the first `$name`, which lets a union carry
		// spaces around its pipes. Horizontal whitespace only for the
		// description, or it would swallow the next line.
		preg_match_all(
			'#@var[ \t]+(.+?)[ \t]+\$(\w+)[ \t]*([^\n\r]*)#',
			$docblock,
			$matches,
			PREG_SET_ORDER
		);

		$params = [];

		foreach ($matches as [, $doc, $name, $description]) {
			$type = new Type(preg_replace('#\s*\|\s*#', '|', trim($doc)));
			$injected = in_array($name, self::INJECTED, true);

			$params[$name] = [
				'type'        => $type->doc,
				'description' => trim($description),
				// Kirby supplies these, so a call site may pass one without it
				// being an undocumented key, but nothing should suggest them
				'injected'    => $injected,
				'required'    => $injected === false
					&& $type->isRequired()
					&& $this->hasDefault($source, $name) === false,
				'values'      => $type->literals(),
				'scalar'      => $type->acceptsString()
			];
		}

		return $params;
	}

	/**
	 * Parameters a snippet declares only in code. The list is necessarily
	 * incomplete, since a parameter used without a fallback leaves no trace, so
	 * these drive completion but must never make an unknown key reportable.
	 */
	private function inferred(string $source): array
	{
		preg_match_all(
			// The optional paren covers `$vertical = ($vertical ?? false) || …`
			'#\$(\w+)\s*(?:\?\?=|=\s*\(?\s*\$\1\s*(?:\?\?|\?:))\s*([^;\n]*)#',
			$source,
			$matches,
			PREG_SET_ORDER
		);

		$params = [];

		foreach ($matches as [, $name, $default]) {
			if (in_array($name, self::INJECTED, true) === true) {
				continue;
			}

			$type = $this->guess($default);

			$params[$name] = [
				'type'        => $type,
				'description' => '',
				'injected'    => false,
				'inferred'    => true,
				'required'    => false,
				'values'      => [],
				'scalar'      => $type === 'mixed' || $type === 'string'
			];
		}

		return $params;
	}

	/**
	 * Enough of a type to keep the string check honest. Anything unrecognised
	 * stays `mixed`, which reports nothing.
	 */
	private function guess(string $default): string
	{
		return match (true) {
			preg_match('#^[\'"]#', $default) === 1        => 'string',
			preg_match('#^(true|false)\b#i', $default) === 1 => 'bool',
			preg_match('#^\d+\.\d#', $default) === 1      => 'float',
			preg_match('#^\d+#', $default) === 1          => 'int',
			preg_match('#^\[#', $default) === 1           => 'array',
			default                                       => 'mixed'
		};
	}

	/**
	 * A snippet that falls back to a default is optional however its type is
	 * written, and plenty of real snippets document `array $attributes` while
	 * doing `$attributes ?? []`. The code is the authority, not the docblock.
	 */
	private function hasDefault(string $source, string $name): bool
	{
		return preg_match('#\$' . preg_quote($name, '#') . '\s*(\?\?|\?:)#', $source) === 1;
	}

	private function source(string $snippet): string
	{
		$file = $this->files[$snippet] ?? null;

		return $file === null ? '' : (F::read($file) ?: '');
	}

	/**
	 * The first block that documents anything, so a licence header above it
	 * does not win.
	 */
	private function docblock(string $source): string|null
	{
		preg_match_all('#/\*\*(.*?)\*/#s', $source, $blocks);

		foreach ($blocks[1] as $block) {
			if (str_contains($block, '@var') === true) {
				return $block;
			}
		}

		return null;
	}

	private function isIgnored(string $snippet): bool
	{
		$patterns = $this->kirby->option('medienbaecker.kirby-lens.ignore') ?? self::IGNORED;

		foreach ($patterns as $pattern) {
			if (preg_match($pattern, $snippet) === 1) {
				return true;
			}
		}

		return false;
	}
}
