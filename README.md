# Kirby Lens

My attempt at getting better code completion, checks and navigation for [Kirby](https://getkirby.com/) projects in VSCode.

<img width="1967" height="1014" alt="Screenshot of VSCode auto-suggesting a variant of a button component: filled or outlined." src="https://github.com/user-attachments/assets/2bd35eaf-970a-4611-88dc-87b1d702a6ac" />

It boots Kirby to see what exists, so plugin-registered blueprints, fields, methods and tags are all known. That is a PHP script run against your project: nothing is installed into it, and no account, key or network access is involved.

Written with a lot of help from Claude.

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

Problems appear for the files you have open. For everything at once, run **Kirby Lens: Check whole project** from the command palette. The results stay until you run it again; files you open or edit keep correcting themselves.

### Navigation

- **Cmd-click** a snippet name, a translation key, or `extends:` and `fieldsets:` in a blueprint
- **F2** renames a snippet, call sites and file
- **Hover** a snippet name or key for its documentation
- Every `t()` call shows what it resolves to, beside it

## Install

Not on the Marketplace yet. Download the `.vsix` from the [latest release](https://github.com/medienbaecker/kirby-lens/releases/latest) and either drag it onto the Extensions view, or:

```sh
code --install-extension kirby-lens-0.1.37.vsix
```

It needs `php` on the `PATH` VS Code inherits. If it isn't, point `kirbyLens.php` at it.

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

## Short snippet helpers

A project that wraps `snippet()` in a shorter helper is found on its own, with nothing to configure:

```php
function s($name, ...$data) {
    return snippet($name, data: $data, return: true);
}
```

Calls to it complete and check exactly as `snippet()` does, with the named arguments read as the snippet's parameters:

```php
s('button', variant: '…')   // filled, outlined, text
s('button', labl: 'x')      // not a documented parameter
```

A function counts as a helper only where its own first argument is what it passes to `snippet()` as the name, so one that renders a snippet of its own choosing is left alone. Where a helper labels a call in the name itself, as `s('o:layout')` or `s('>layout')` for a slot, the label is ignored when resolving and kept when completing, renaming or opening the file.

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
