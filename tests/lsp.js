/**
 * Just enough LSP to drive the installed Intelephense over stdio.
 *
 * Shared by `tests/intelephense.js`, which checks what the language server does
 * and does not reject, and by `types.js`, which records the receiver types the
 * field check filters on. Both need the same framing and neither should own it.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * The installed server, or null. Matched by prefix rather than by version, so a
 * routine Intelephense update does not silently skip every test that uses it.
 */
function serverPath() {
	const extensions = path.join(os.homedir(), ".vscode/extensions");

	if (fs.existsSync(extensions) === false) {
		return null;
	}

	const found = fs
		.readdirSync(extensions)
		.filter((name) => name.startsWith("bmewburn.vscode-intelephense-client-"))
		.sort()
		.pop();

	if (found === undefined) {
		return null;
	}

	const server = path.join(extensions, found, "node_modules/intelephense/lib/intelephense.js");

	return fs.existsSync(server) === true ? server : null;
}

const uri = (file) => "file://" + file;

/**
 * A running server. `send` resolves for a request and returns immediately for a
 * notification, which is not a detail to get wrong: sending `didOpen` as a
 * request leaves every later hover answering nothing, which reads exactly like
 * the server knowing nothing about the file.
 */
function start(server, { onNotification } = {}) {
	const child = spawn("node", [server, "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
	const pending = new Map();
	let buffer = Buffer.alloc(0);
	let seq = 0;

	const send = (method, params, isRequest = true) => {
		const message = { jsonrpc: "2.0", method, params };

		if (isRequest === true) {
			message.id = ++seq;
		}

		const body = Buffer.from(JSON.stringify(message), "utf8");
		child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
		child.stdin.write(body);

		return isRequest === true
			? new Promise((resolve) => pending.set(message.id, resolve))
			: Promise.resolve();
	};

	child.stdout.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);

		while (true) {
			const end = buffer.indexOf("\r\n\r\n");

			if (end === -1) {
				return;
			}

			const header = /Content-Length: (\d+)/i.exec(buffer.slice(0, end).toString());

			if (header === null) {
				return;
			}

			const start = end + 4;
			const length = Number(header[1]);

			if (buffer.length < start + length) {
				return;
			}

			const message = JSON.parse(buffer.slice(start, start + length).toString("utf8"));
			buffer = buffer.slice(start + length);

			if (message.id !== undefined && pending.has(message.id) === true) {
				pending.get(message.id)(message.result);
				pending.delete(message.id);
				continue;
			}

			onNotification?.(message);
		}
	});

	return { send, kill: () => child.kill() };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * An offset as the line and character the protocol wants.
 */
function position(text, offset) {
	const before = text.slice(0, offset);

	return {
		line: before.split("\n").length - 1,
		character: offset - (before.lastIndexOf("\n") + 1)
	};
}

/**
 * The type out of a hover, or null. Intelephense answers in markdown, as
 * ``_@var_ `\Kirby\Cms\Page $page` `` or ``_@param_ `\Kirby\CLI\CLI $cli` ``.
 */
function typeOf(hover) {
	const value = String(hover?.contents?.value ?? hover?.contents ?? "");
	const declared = /`\s*([^`]*?)\s+\$\w+\s*`/.exec(value);

	return declared === null ? null : declared[1].trim();
}

module.exports = { serverPath, start, uri, wait, position, typeOf };
