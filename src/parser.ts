/**
 * Lightweight TOML-subset parser for Codex environment files.
 *
 * Pure module with zero external dependencies (only node:fs / node:path), so
 * it can be unit-tested without the pi runtime.
 *
 * Codex stores project-local run actions in TOML files under
 * `.codex/environments/` (canonical name: environment.toml). This parser
 * targets the subset Codex emits (see https://github.com/openai/codex and
 * openai/plugins run-action skills):
 *
 *   version = 1
 *   name = "env-name"
 *
 *   [setup]
 *   script = "..."
 *
 *   [[actions]]
 *   name = "Action"
 *   icon = "run"
 *   command = "..."        # single-line or '''multi-line''' literal
 *
 * Supports comments, single-line basic strings with common escapes, and
 * triple-quoted multi-line literals (''' or """), plus [setup]/[cleanup]
 * tables and [[actions]] array-of-tables headers.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** One [[actions]] entry from an environment TOML file. */
export interface EnvAction {
	name: string;
	icon?: string;
	command: string;
	/** Source file this action came from (for diagnostics). */
	file: string;
}

/** Parsed environment file (only the fields we care about). */
export interface EnvFile {
	name?: string;
	setup?: string;
	cleanup?: string;
	actions: EnvAction[];
}

type Section = "setup" | "cleanup" | "actions" | null;

interface MultiLineState {
	quote: string;
	key: string;
	section: Section;
	action: Partial<EnvAction> | undefined;
	buf: string[];
}

/** Parse a TOML string for the subset Codex uses in environment files. */
export function parseEnvironmentToml(toml: string, file: string): EnvFile {
	const env: EnvFile = { actions: [] };
	let section: Section = null;
	let currentAction: Partial<EnvAction> | undefined;
	let multi: MultiLineState | null = null;

	const lines = toml.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Inside a triple-quoted literal: accumulate until the closing quote.
		if (multi) {
			const end = line.indexOf(multi.quote);
			if (end === -1) {
				multi.buf.push(line);
				continue;
			}
			multi.buf.push(line.slice(0, end));
			const value = trimMultiline(multi.buf.join("\n"));
			setValue(multi.key, value, multi.section, multi.action);
			multi = null;
			continue;
		}

		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;

		// [[actions]] array-of-tables header.
		if (trimmed.startsWith("[[") && trimmed.endsWith("]]")) {
			const tableName = trimmed.slice(2, -2).trim();
			section = tableName === "actions" ? "actions" : null;
			currentAction = tableName === "actions" ? {} : undefined;
			continue;
		}

		// [setup] / [cleanup] table headers.
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			const tableName = trimmed.slice(1, -1).trim();
			if (tableName === "setup" || tableName === "cleanup") {
				section = tableName;
				currentAction = undefined;
			} else {
				section = null;
				currentAction = undefined;
			}
			continue;
		}

		// key = value pair.
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		const value = splitComment(trimmed.slice(eq + 1).trim());

		// Triple-quoted literal start (may be on the same line as content).
		const triple = value.startsWith("'''") ? "'''" : value.startsWith('"""') ? '"""' : null;
		if (triple) {
			const rest = value.slice(3);
			const end = rest.indexOf(triple);
			if (end !== -1) {
				// Single-line triple-quoted value.
				setValue(key, rest.slice(0, end), section, currentAction);
			} else {
				multi = { quote: triple, key, section, action: currentAction, buf: rest.length > 0 ? [rest] : [] };
			}
			continue;
		}

		if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
			setValue(key, parseEscapes(value.slice(1, -1)), section, currentAction);
		}
		// Non-string values (version = 1, booleans, etc.) are ignored.
	}

	return env;

	function setValue(key: string, value: string, sec: Section, action: Partial<EnvAction> | undefined) {
		if (sec === null && key === "name") {
			env.name = value;
		} else if (sec === "actions" && action && (key === "name" || key === "icon" || key === "command")) {
			(action as Record<string, string>)[key] = value;
			if (action.name && action.command && !env.actions.includes(action as EnvAction)) {
				env.actions.push({ ...(action as EnvAction), file });
			}
		} else if (sec === "setup" && key === "script") {
			env.setup = value;
		} else if (sec === "cleanup" && key === "script") {
			env.cleanup = value;
		}
	}
}

/** TOML multi-line literals trim the leading and trailing newline. */
function trimMultiline(value: string): string {
	let out = value;
	if (out.startsWith("\n")) out = out.slice(1);
	if (out.endsWith("\n")) out = out.slice(0, -1);
	return out;
}

/** Parse basic-string escapes (\n \t \r \" \\ and pass-through for others). */
function parseEscapes(raw: string): string {
	return raw.replace(/\\(.)/g, (_m, ch: string) => {
		switch (ch) {
			case "n":
				return "\n";
			case "t":
				return "\t";
			case "r":
				return "\r";
			case '"':
				return '"';
			case "\\":
				return "\\";
			default:
				return ch;
		}
	});
}

/** Remove a trailing `# comment` that sits outside double quotes. */
function splitComment(value: string): string {
	let inQuote = false;
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (ch === '"') inQuote = !inQuote;
		if (ch === "#" && !inQuote) return value.slice(0, i).trimEnd();
	}
	return value;
}

/**
 * Locate the nearest `.codex/environments` directory by walking up from
 * `cwd` (mirrors how Codex resolves project-root configs). Returns undefined
 * when none exists.
 */
export function findEnvironmentsDir(cwd: string): string | undefined {
	let dir = cwd;
	for (;;) {
		const candidate = join(dir, ".codex", "environments");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return undefined; // reached filesystem root
		dir = parent;
	}
}

/** Load all environment TOML files from a directory, sorted by filename. */
export function loadEnvironmentFiles(envDir: string): EnvFile[] {
	let files: string[];
	try {
		files = readdirSync(envDir).filter((f) => f.endsWith(".toml")).sort();
	} catch {
		return [];
	}
	const result: EnvFile[] = [];
	for (const f of files) {
		try {
			result.push(parseEnvironmentToml(readFileSync(join(envDir, f), "utf8"), join(envDir, f)));
		} catch {
			// Skip unreadable/corrupt files rather than breaking the whole extension.
		}
	}
	return result;
}

/** Collect all actions from every environment file, deduplicated by name. */
export function collectActions(envDir: string): EnvAction[] {
	const seen = new Set<string>();
	const actions: EnvAction[] = [];
	for (const env of loadEnvironmentFiles(envDir)) {
		for (const action of env.actions) {
			const key = action.name.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			actions.push(action);
		}
	}
	return actions;
}
