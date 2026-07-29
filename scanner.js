/**
 * Hand-rolled PHP scanning.
 */

/**
 * The same text with every comment, string, heredoc and stretch of markup
 * replaced by spaces, offsets preserved.
 */
function mask(text) {
	const out = text.split("");
	const blank = (from, to) => {
		for (let i = from; i < to && i < out.length; i++) {
			if (out[i] !== "\n") {
				out[i] = " ";
			}
		}
	};

	let i = 0;
	let php = false;

	while (i < text.length) {
		if (php === false) {
			const open = text.indexOf("<?", i);

			blank(i, open === -1 ? text.length : open);

			if (open === -1) {
				break;
			}

			// `<?php`, the `<?=` echo shorthand, or the short tag
			const body = text.startsWith("<?php", open)
				? open + 5
				: text.startsWith("<?=", open)
					? open + 3
					: open + 2;

			blank(open, body);
			i = body;
			php = true;
			continue;
		}

		const char = text[i];
		const next = text[i + 1];

		if (char === "?" && next === ">") {
			blank(i, i + 2);
			i += 2;
			php = false;
			continue;
		}

		if ((char === "/" && next === "/") || char === "#") {
			const end = lineEnd(text, i);
			blank(i, end);
			i = end;
			continue;
		}

		if (char === "/" && next === "*") {
			const close = text.indexOf("*/", i + 2);
			const end = close === -1 ? text.length : close + 2;
			blank(i, end);
			i = end;
			continue;
		}

		if (char === "<" && text.startsWith("<<<", i)) {
			const end = heredocEnd(text, i);
			blank(i, end);
			i = end;
			continue;
		}

		if (char === "'" || char === '"') {
			const start = i;
			i++;

			while (i < text.length && text[i] !== char) {
				i += text[i] === "\\" ? 2 : 1;
			}

			blank(start, Math.min(i + 1, text.length));
			i++;
			continue;
		}

		i++;
	}

	return out.join("");
}

/**
 * Every `->name(` in real code, with the offset of the name.
 *
 * `receiver` is the variable the call sits on, where that is a plain one. A
 * chain like `$a->b()->c()` leaves it null rather than guessing: what `c` is
 * called on is whatever `b()` returned, which nothing here can know.
 */
function scanMethods(text) {
	const found = [];
	const regex = /(?:->|\?->)\s*([a-zA-Z_]\w*)\s*\(/g;
	const code = mask(text);
	let match;

	while ((match = regex.exec(code)) !== null) {
		const start = match.index + match[0].indexOf(match[1]);

		found.push({
			name: match[1],
			start,
			end: start + match[1].length,
			receiver: baseOf(code, match.index)
		});
	}

	return found;
}

/**
 * Calls to named functions, with their first argument.
 */
function scanCalls(text, names) {
	const found = [];
	const code = mask(text);

	// Longest first, so `t` cannot win the alternation against `tt`
	const alternatives = [...names]
		.sort((a, b) => b.length - a.length)
		.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("|");

	const pattern = new RegExp(`(?:^|[^\\w$>-])(${alternatives})\\s*\\(`, "g");
	let match;

	while ((match = pattern.exec(code)) !== null) {
		found.push({
			name: match[1],
			...argument(text, match.index + match[0].length)
		});
	}

	return found;
}

/**
 * The first argument of a call, read from just after its `(`.
 */
function argument(text, from) {
	let i = from;

	while (i < text.length && /\s/.test(text[i]) === true) {
		i++;
	}

	const quote = text[i];

	if (quote !== "'" && quote !== '"') {
		return { value: null, start: i, end: i, literal: false, second: "none" };
	}

	const start = i;
	i++;

	while (i < text.length && text[i] !== quote) {
		i += text[i] === "\\" ? 2 : 1;
	}

	const raw = text.slice(start + 1, i);
	const end = Math.min(i + 1, text.length);

	let after = end;

	while (after < text.length && /\s/.test(text[after]) === true) {
		after++;
	}

	// The string has to *be* the argument, not merely start it. `t('job.' . $x)`
	// opens with a perfectly good literal and is still a computed key.
	const delimiter = text[after];
	const whole = delimiter === "," || delimiter === ")";

	// Shape only. What it means depends on the function: any non-null second
	// argument short-circuits t(), while tt() moves an array one to $replace.
	let second = "none";

	if (delimiter === ",") {
		after++;

		while (after < text.length && /\s/.test(text[after]) === true) {
			after++;
		}

		const next = text[after];

		second =
			next === "'" || next === '"'
				? "string"
				: next === "["
					? "array"
					: /^null\b/i.test(text.slice(after, after + 5)) === true
						? "null"
						: "other";
	}

	return {
		value: decode(raw, quote),
		start,
		end,
		// Interpolation makes a double-quoted string an expression too
		literal: whole === true && (quote === "'" || /\$/.test(raw) === false),
		second
	};
}

function scan(text) {
	const found = [];
	const stack = [];
	let calls = 0;
	let i = 0;

	while (i < text.length) {
		const char = text[i];
		const next = text[i + 1];

		if ((char === "/" && next === "/") || char === "#") {
			i = lineEnd(text, i);
			continue;
		}

		if (char === "/" && next === "*") {
			const close = text.indexOf("*/", i + 2);
			i = close === -1 ? text.length : close + 2;
			continue;
		}

		if (char === "<" && text.startsWith("<<<", i)) {
			i = heredocEnd(text, i);
			continue;
		}

		if (char === "'" || char === '"') {
			const start = i;
			i++;

			while (i < text.length && text[i] !== char) {
				i += text[i] === "\\" ? 2 : 1;
			}

			const frame = stack.findLast((entry) => entry.call !== undefined);

			if (frame?.snippet === true) {
				classify(text, frame, stack, found, {
					value: decode(text.slice(start + 1, i), char),
					// Interpolation makes it an expression, not a literal
					literal: char === "'" || /\$/.test(text.slice(start + 1, i)) === false,
					start,
					end: i + 1,
					closed: i < text.length
				});
			}

			i++;
			continue;
		}

		if (char === "(") {
			const before = text.slice(Math.max(0, i - 40), i);

			stack.push({
				snippet: /(?:^|[^\w$>-])snippet\s*$/.test(before),
				call: calls++,
				name: null,
				key: null,
				arg: 0
			});

			i++;
			continue;
		}

		if (char === "[") {
			// A subscript like $icon['name'] rather than an array literal
			const subscript = /[\w\]\)]\s*$/.test(text.slice(Math.max(0, i - 20), i));
			stack.push({ array: subscript === false, expect: "key" });
			i++;
			continue;
		}

		// A match body or closure is its own scope, never the data array
		if (char === "{" && stack.length > 0) {
			stack.push({ array: false });
			i++;
			continue;
		}

		if (char === ")" || char === "]" || (char === "}" && stack.length > 0)) {
			stack.pop();
			i++;
			continue;
		}

		const level = stack[stack.length - 1];

		// Which argument a string sits in is what tells a name from data, and a
		// name that is not a plain string leaves nothing to fall back on
		if (char === "," && level?.call !== undefined) {
			level.arg++;
		}

		if (level?.array === true) {
			// Only a comma returns to expecting a key, so the rest of a
			// concatenation or ternary is neither a second value nor a key
			if (char === ",") {
				level.expect = "key";

				// A numeric or computed key must not inherit the previous one
				const frame = stack.findLast((entry) => entry.call !== undefined);

				if (frame !== undefined) {
					frame.key = null;
				}
			}

			if (char === "=" && next === ">") {
				level.expect = "value";
				i += 2;
				continue;
			}
		}

		i++;
	}

	return found;
}

function classify(text, frame, stack, found, literal) {
	const level = stack[stack.length - 1];
	const emit = (kind, key) =>
		found.push({
			kind,
			call: frame.call,
			snippet: kind === "name" ? null : frame.name,
			key: key ?? null,
			value: literal.value,
			start: literal.start,
			end: literal.end,
			closed: literal.closed
		});

	// The first argument is the name, written either directly or as the first
	// entry of a `snippet(['primary', 'fallback'], ...)` list. Nothing else in
	// that argument is data, so it is read for a name or not at all.
	if (frame.arg === 0) {
		const { before, after } = around(text, literal);
		const list = level?.array === true && stack[stack.indexOf(frame) + 1] === level;

		// A name being typed has nothing after it to judge yet, and one left
		// unterminated closes on whatever quote the markup below happens to hold
		const typing = literal.closed === false || literal.value.includes("\n") === true;

		// The string has to *be* the argument rather than one operand of it:
		// `snippet('tiptap/' . $x)` and `snippet($x . '/schema')` each open or
		// close with a perfectly good literal and name no snippet at all
		const whole =
			(level === frame || list === true) &&
			(list === true ? before === "[" || before === "," : before === "(") &&
			(typing === true || after === "," || after === (list === true ? "]" : ")"));

		if (frame.name === null && literal.literal === true && whole === true) {
			frame.name = literal.value;
			emit("name");
		}

		return;
	}

	// Only the data array itself, not anything nested inside it
	if (level?.array !== true || stack[stack.indexOf(frame) + 1] !== level) {
		return;
	}

	if (level.expect === "key") {
		frame.key = literal.value;
		emit("key");
		return;
	}

	// The value is taken, so the remainder of a concatenation is ignored rather
	// than read as the next key: 'a' => '<div>' . snippet(…) . '</div>'
	if (level.expect === "done") {
		return;
	}

	// Only a literal standing alone as the value, not one inside an expression.
	// Anything else leaves the level expecting a value, so the rest of that
	// expression is skipped rather than being read as the next key.
	if (literal.literal === true && /=>\s*$/.test(text.slice(Math.max(0, literal.start - 40), literal.start)) === true) {
		emit("value", frame.key);
		level.expect = "done";
	}
}

/**
 * What a chain of calls ultimately hangs off, read backwards from a `->`.
 *
 * `$this->cli->bold()->out()` answers `cli`, not `$this`: the property is what
 * carries the type, and hovering `$this` would say the enclosing class instead.
 * `$page->children()->listed()` answers `$page`. Every `()` group and the name
 * in front of it is stepped over, so however long the chain is the answer is
 * the one value the whole thing started from.
 *
 * That base is a sound stand-in for each link because the links are exactly the
 * case a type cannot be had for: `Kirby\CLI\CLI::__call` declares no return, so
 * `$cli->bold()` is `mixed` and so is everything after it.
 */
function baseOf(code, from) {
	let i = from;
	const spaces = () => {
		while (i > 0 && /\s/.test(code[i - 1]) === true) {
			i--;
		}
	};

	const arrow = () => {
		spaces();

		if (code[i - 1] === ">" && code[i - 2] === "-") {
			i -= 2;
			return true;
		}

		return false;
	};

	// A chain cannot be longer than the file, and a malformed one must not spin
	for (let guard = 0; guard < 200; guard++) {
		spaces();

		if (code[i - 1] === ")") {
			let depth = 0;

			while (i > 0) {
				i--;

				if (code[i] === ")") {
					depth++;
				} else if (code[i] === "(") {
					depth--;

					if (depth === 0) {
						break;
					}
				}
			}

			if (depth !== 0) {
				return null;
			}

			// The name the parentheses belong to, then the arrow before it
			while (i > 0 && /\w/.test(code[i - 1]) === true) {
				i--;
			}

			if (arrow() === false) {
				return null;
			}

			continue;
		}

		const end = i;

		while (i > 0 && /\w/.test(code[i - 1]) === true) {
			i--;
		}

		if (i === end) {
			return null;
		}

		if (code[i - 1] === "$") {
			i--;
		}

		return { name: code.slice(i, end), start: i, end };
	}

	return null;
}

/**
 * The nearest non-space character either side of a literal.
 */
function around(text, literal) {
	let before = literal.start - 1;

	while (before >= 0 && /\s/.test(text[before]) === true) {
		before--;
	}

	let after = literal.end;

	while (after < text.length && /\s/.test(text[after]) === true) {
		after++;
	}

	return { before: text[before] ?? "", after: text[after] ?? "" };
}

/**
 * PHP unescapes `\'` and `\\` inside single quotes, so a documented value
 * like `it's` has to be compared against the decoded form.
 */
function decode(value, quote) {
	return quote === "'" ? value.replace(/\\(['\\])/g, "$1") : value;
}

function heredocEnd(text, from) {
	const opener = /^<<<[ \t]*(['"]?)([A-Za-z_]\w*)\1\r?\n/.exec(text.slice(from, from + 120));

	if (opener === null) {
		return from + 3;
	}

	// PHP 7.3+ closes on the identifier at the start of a line followed by any
	// non-identifier character, so `HTML);` closes and `HTMLisms` does not.
	// Body prose beginning with the closer word closes it too, and is a parse
	// error in PHP itself.
	const closer = new RegExp(`^[ \\t]*${opener[2]}(?![a-zA-Z0-9_])`, "m");
	const rest = text.slice(from + opener[0].length);
	const match = closer.exec(rest);

	return match === null ? text.length : from + opener[0].length + match.index + match[0].length;
}

function lineEnd(text, from) {
	const nl = text.indexOf("\n", from);
	return nl === -1 ? text.length : nl;
}

module.exports = { scan, scanCalls, scanMethods, mask };
