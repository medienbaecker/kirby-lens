# Kirby Lens

My attempt at getting better code completion, checks and navigation for [Kirby](https://getkirby.com/) projects in VSCode by letting Claude read the source code.

It boots Kirby to see what exists, so plugin-registered blueprints, fields, methods and tags are all known.

## Features

### Completion

- **Snippets**: names, keys and values, from the `@var` docblocks in the snippets themselves
- **Blueprint fields** after `$page->`, narrowed to the blueprint the template renders and the content files using this template
- **Field methods**, with the ones that suit the field type first
- **Translation keys** inside `t('…')`

```php
snippet('…')                            // every snippet in the project
snippet('button', ['…'])                // label, variant
snippet('button', ['variant' => '…'])   // filled, outlined, text
```

### Problems

Kirby fails quietly. None of these are logged or shown, not even with `debug`:

```php
$page->headlien()                  // in no blueprint, content file or method list
snippet('meow')                    // no such snippet
snippet('button', ['labl' => 'x']) // not a documented parameter
t('form.first_name')               // in no language file
collection('recipe')               // not a collection
```

```yaml
# site/blueprints/blocks/card.yml
label: "{{ title }}" # this block has kicker, image, headline
```

Quick fixes correct a name, create a missing snippet, or add a type hint.

Only your own code is checked, plugins included, but not the ones you installed. Where Intelephense knows a variable isn't a Kirby object, `$cli->arg()` and the like are left alone.

### Navigation

- **Cmd-click** a snippet name, a translation key, or `extends:` and `fieldsets:` in a blueprint
- **F2** renames a snippet, call sites and file
- **Hover** a snippet name or key for its documentation
- Every `t()` call shows what it resolves to, beside it

## Settings

```json
{
	"kirbyLens.php": "php",
	"kirbyLens.diagnostics": true,
	"kirbyLens.manifest": "site/cache/kirby-lens/manifest.json"
}
```

**PHP binary**

Point this at your binary if `php` isn't on the PATH VS Code inherits, which happens with Herd, Docker and some Valet setups.

**Diagnostics**

- `true` (default): report problems
- `false`: completion, hover and navigation only

**Manifest**

Where the generated index goes. Only needs changing if your project moves its cache root.

## Ignoring snippets

Blocks, modules and playgrounds are skipped by default. Replace that list in `config.php`, where `[]` covers everything:

```php
return [
    'medienbaecker.kirby-lens.ignore' => [
        '#^blocks/#',
        '#^modules/#',
        '#^playground/#',
        '#^(header|footer|menu|logo)$#',
    ],
];
```

## Documenting snippets

```php
<?php
/**
 * Button Component
 *
 * @var string|null $label
 * @var 'filled'|'outlined'|'text'|null $variant Visual style
 */
```

The docblock also types the variables inside the snippet. Undocumented snippets are never reported.

A parameter counts as optional when the code gives it a fallback (`??`, `??=` or `?:`), whatever the type says. Those also declare a parameter, so `$variant ??= 'filled'` completes without a docblock.
