<?php

namespace Medienbaecker\KirbyLens;

/**
 * A documented type from a snippet's `@var` line.
 */
final readonly class Type
{
	public function __construct(public string $doc) {}

	/**
	 * Splits the union on `|`, ignoring pipes inside quoted literals. `?string`
	 * expands to both halves, so the shorthand and the written-out union answer
	 * alike: read as one part it is neither `null` nor `string`, which makes an
	 * optional parameter required and a string value illegal.
	 */
	public function parts(): array
	{
		$parts = [];
		$current = '';
		$quoted = false;

		for ($i = 0; $i < strlen($this->doc); $i++) {
			$char = $this->doc[$i];

			if ($char === '\\' && $quoted === true) {
				$current .= $char . ($this->doc[++$i] ?? '');
				continue;
			}

			if ($char === "'") {
				$quoted = $quoted === false;
			}

			if ($char === '|' && $quoted === false) {
				$parts[] = trim($current);
				$current = '';
				continue;
			}

			$current .= $char;
		}

		$parts[] = trim($current);

		$expanded = [];

		foreach ($parts as $part) {
			if ($part === '') {
				continue;
			}

			if (str_starts_with($part, '?') === true) {
				$expanded[] = substr($part, 1);
				$expanded[] = 'null';
				continue;
			}

			$expanded[] = $part;
		}

		return array_values(array_unique($expanded));
	}

	public function isRequired(): bool
	{
		return in_array('null', $this->parts(), true) === false;
	}

	/**
	 * The values of a literal union, or nothing for any other type.
	 */
	public function literals(): array
	{
		$parts = $this->withoutNull();

		foreach ($parts as $part) {
			if (preg_match("#^'(?:[^'\\\\]|\\\\.)*'$#", $part) !== 1) {
				return [];
			}
		}

		return array_map(
			fn (string $part): string => str_replace(["\\'", '\\\\'], ["'", '\\'], substr($part, 1, -1)),
			$parts
		);
	}

	/**
	 * Whether a string literal is legal here, which is what makes
	 * `'compact' => 'yes'` reportable when the docblock says bool.
	 */
	public function acceptsString(): bool
	{
		$parts = $this->withoutNull();

		if ($parts === []) {
			return true;
		}

		foreach ($parts as $part) {
			if ($part === 'string' || $part === 'mixed' || str_starts_with($part, "'") === true) {
				return true;
			}
		}

		return false;
	}

	private function withoutNull(): array
	{
		return array_values(array_filter(
			$this->parts(),
			fn (string $part): bool => $part !== 'null'
		));
	}
}
