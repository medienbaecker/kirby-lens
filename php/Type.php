<?php

namespace Medienbaecker\KirbyLens;

/**
 * A documented type from a snippet's `@var` line.
 */
final readonly class Type
{
	public function __construct(public string $doc) {}

	/**
	 * Splits the union on `|`, ignoring pipes inside quoted literals.
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

		return array_values(array_filter($parts, fn (string $part): bool => $part !== ''));
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
