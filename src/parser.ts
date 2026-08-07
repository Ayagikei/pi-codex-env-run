/**
 * Lightweight TOML-subset parser, writer and validator for Codex environment
 * files.
 *
 * Pure module with zero external dependencies (only node:fs / node:path), so
 * it can be unit-tested without the pi runtime.
 *
 * Codex stores project-local run actions in TOML files under
 * `.codex/environments/` (canonical name: environment.toml). This module
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
 *
 * Editing is block-precise: every [[actions]] block records its source line
 * range, so add/update/remove rewrite only the target block and leave all
 * other lines (comments, ordering, formatting) untouched.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** One [[actions]] entry from an environment TOML file. */
export interface EnvAction {
	name: string;
	icon?: string;
	command: string;
	/** Source file this action came from (for diagnostics). */
	file: string;
}

/** Source position of one [[actions]] block (1-based inclusive lines). */
export interface ActionBlock {
	action: Partial<EnvAction>;
	/** First line of the `[[actions]]` header. */
	startLine: number;
	/** Last line that belongs to this block (any key or multi-line literal end). */
	endLine: number;
}

/** Parsed environment file (only the fields we care about). */
export interface EnvFile {
	name?: string;
	setup?: string;
	cleanup?: string;
	actions: EnvAction[];
	/** All [[actions]] blocks with source positions, including incomplete ones. */
	blocks: ActionBlock[];
	/** Structural parse problems (e.g. unterminated multi-line literal). */
	errors: string[];
}

type Section = "setup" | "cleanup" | "actions" | null;

interface MultiLineState {
	quote: string;
	key: string;
	section: Section;
	action: Partial<EnvAction> | undefined;
	buf: string[];
	startLine: number;
}

interface PendingBlock {
	action: Partial<EnvAction>;
	startLine: number;
	endLine: number;
}

/** Parse a TOML string for the subset Codex uses in environment files. */
export function parseEnvironmentToml(toml: string, file: string): EnvFile {
	const env: EnvFile = { actions: [], blocks: [], errors: [] };
	let section: Section = null;
	let currentAction: Partial<EnvAction> | undefined;
	let pending: PendingBlock | null = null;
	let multi: MultiLineState | null = null;

	const lines = toml.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNo = i + 1;

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
			if (multi.section === "actions" && pending) pending.endLine = lineNo;
			multi = null;
			continue;
		}

		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;

		// [[actions]] array-of-tables header.
		if (trimmed.startsWith("[[") && trimmed.endsWith("]]")) {
			const tableName = trimmed.slice(2, -2).trim();
			finalizePending();
			if (tableName === "actions") {
				section = "actions";
				currentAction = {};
				pending = { action: currentAction, startLine: lineNo, endLine: lineNo };
			} else {
				section = null;
				currentAction = undefined;
			}
			continue;
		}

		// [setup] / [cleanup] table headers.
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			const tableName = trimmed.slice(1, -1).trim();
			finalizePending();
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
				if (section === "actions" && pending) pending.endLine = lineNo;
			} else {
				multi = { quote: triple, key, section, action: currentAction, buf: rest.length > 0 ? [rest] : [], startLine: lineNo };
			}
			continue;
		}

		if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
			setValue(key, parseEscapes(value.slice(1, -1)), section, currentAction);
		}
		// Non-string values (version = 1, booleans, etc.) are ignored.
		if (section === "actions" && pending) pending.endLine = lineNo;
	}

	// Unterminated multi-line literal at EOF.
	if (multi) {
		env.errors.push(`unterminated multi-line string for key "${multi.key}" (starts on line ${multi.startLine ?? "?"})`);
	}
	finalizePending();

	return env;

	function finalizePending() {
		if (!pending) return;
		env.blocks.push({ action: { ...pending.action }, startLine: pending.startLine, endLine: pending.endLine });
		pending = null;
	}

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

/** Escape a string for use inside a TOML basic string ("..."). */
export function escapeTomlString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\t/g, "\\t");
}

/** Render one [[actions]] block as TOML text (no trailing newline). */
export function renderActionBlock(action: { name: string; icon?: string; command: string }): string {
	const lines = ["[[actions]]", `name = "${escapeTomlString(action.name)}"`];
	if (action.icon) lines.push(`icon = "${escapeTomlString(action.icon)}"`);
	if (action.command.includes("\n")) {
		lines.push("command = '''", action.command, "'''");
	} else {
		lines.push(`command = "${escapeTomlString(action.command)}"`);
	}
	return lines.join("\n");
}

/** Append a new action block to the end of the TOML document. */
export function addActionToToml(toml: string, action: { name: string; icon?: string; command: string }): string {
	const block = renderActionBlock(action);
	const trimmed = toml.replace(/\s+$/, "");
	return trimmed.length > 0 ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

/** Replace an existing action block by name (case-insensitive). Returns null when not found. */
export function updateActionInToml(
	toml: string,
	name: string,
	action: { name?: string; icon?: string; command: string },
): string | null {
	const env = parseEnvironmentToml(toml, "environment.toml");
	const block = env.blocks.find((b) => b.action.name?.toLowerCase() === name.toLowerCase());
	if (!block) return null;
	const rendered = renderActionBlock({
		name: action.name ?? block.action.name ?? name,
		icon: action.icon ?? block.action.icon,
		command: action.command,
	});
	const lines = toml.split(/\r?\n/);
	const prefix = lines.slice(0, block.startLine - 1).join("\n");
	const suffix = lines.slice(block.endLine).join("\n");
	return joinWithNewline(prefix, rendered, suffix);
}

/** Remove an action block by name (case-insensitive). Returns null when not found. */
export function removeActionFromToml(toml: string, name: string): string | null {
	const env = parseEnvironmentToml(toml, "environment.toml");
	const block = env.blocks.find((b) => b.action.name?.toLowerCase() === name.toLowerCase());
	if (!block) return null;
	const lines = toml.split(/\r?\n/);
	const prefix = lines.slice(0, block.startLine - 1);
	const suffix = lines.slice(block.endLine);
	// Drop blank/comment lines directly above the block to avoid orphan gaps.
	while (prefix.length > 0 && prefix[prefix.length - 1].trim() === "") prefix.pop();
	const result = joinWithNewline(prefix.join("\n"), "", suffix.join("\n")).replace(/^\n/, "");
	// Collapse trailing blank lines left by removing the block.
	return result.replace(/\n{2,}$/, "\n");
}

function joinWithNewline(prefix: string, middle: string, suffix: string): string {
	const parts: string[] = [];
	if (prefix.length > 0) parts.push(prefix);
	if (middle.length > 0) parts.push(middle);
	if (suffix.length > 0) parts.push(suffix);
	return parts.join("\n") + (suffix.length > 0 ? "\n" : "");
}

/** One validation finding. */
export interface ValidationIssue {
	level: "error" | "warning";
	message: string;
	line?: number;
	actionName?: string;
}

/** Known Codex action icon values (from openai/codex & openai/plugins usage). */
const KNOWN_ICONS = new Set(["run", "test", "debug", "build", "deploy", "start", "stop", "reset", "e2e"]);

/** Statically validate a single TOML document. Never executes commands. */
export function validateEnvironmentToml(toml: string): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	const env = parseEnvironmentToml(toml, "environment.toml");

	for (const err of env.errors) {
		issues.push({ level: "error", message: err });
	}

	const seen = new Map<string, ActionBlock>();
	for (const block of env.blocks) {
		const { action, startLine } = block;
		const name = action.name?.trim();
		if (!name) {
			issues.push({ level: "error", message: "action is missing required field: name", line: startLine });
			continue;
		}
		if (!action.command?.trim()) {
			issues.push({
				level: "error",
				message: `action "${name}" is missing required field: command`,
				line: startLine,
				actionName: name,
			});
		}
		if (action.icon && !KNOWN_ICONS.has(action.icon)) {
			issues.push({
				level: "warning",
				message: `action "${name}" uses unknown icon "${action.icon}" (known: ${[...KNOWN_ICONS].join(", ")})`,
				line: startLine,
				actionName: name,
			});
		}
		const key = name.toLowerCase();
		if (seen.has(key)) {
			issues.push({
				level: "error",
				message: `duplicate action name "${name}" (first defined on line ${seen.get(key)!.startLine})`,
				line: startLine,
				actionName: name,
			});
		} else {
			seen.set(key, block);
		}
	}
	return issues;
}

/** Validate all TOML files in an environment directory, including cross-file duplicates. */
export function validateEnvironmentDir(envDir: string): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	const seen = new Map<string, string>(); // name(lower) -> file
	for (const env of loadEnvironmentFiles(envDir)) {
		const file = env.actions[0]?.file ?? "";
		for (const block of env.blocks) {
			const name = block.action.name?.trim();
			if (!name) continue;
			const key = name.toLowerCase();
			if (seen.has(key)) {
				issues.push({
					level: "warning",
					message: `duplicate action name "${name}" across files (also in ${seen.get(key)})`,
					line: block.startLine,
					actionName: name,
				});
			} else {
				seen.set(key, file);
			}
		}
	}
	return issues;
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

/** Resolve a target file name within the environment directory (no path traversal). */
export function resolveEnvFile(envDir: string, fileName: string): string | null {
	const base = fileName.split(/[\\/]/).pop() ?? fileName;
	if (!base || base !== fileName || !base.endsWith(".toml")) return null;
	const full = join(envDir, base);
	return existsSync(full) ? full : null;
}

/** Write a TOML document back to disk, preserving trailing newline. */
export function writeEnvironmentFile(file: string, toml: string): void {
	const content = toml.endsWith("\n") ? toml : `${toml}\n`;
	writeFileSync(file, content, "utf8");
}
