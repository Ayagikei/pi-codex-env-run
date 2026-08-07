/**
 * pi-codex-env-run
 *
 * Reuse Codex project environments (.codex/environments/*.toml) inside pi.
 *
 * Codex stores project-local run actions in TOML files under
 * `.codex/environments/` (canonical name: environment.toml). This extension
 * parses those files with a lightweight TOML-subset parser and exposes the
 * actions to pi as:
 *
 *   - `/run <action>`  slash command with action-name completion
 *   - `run_env_action` tool callable by the model
 *
 * The parser deliberately targets the subset Codex emits (see
 * https://github.com/openai/codex and openai/plugins run-action skills):
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
 * No npm dependencies are required: TOML parsing is implemented inline so
 * the package stays dependency-free.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
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

/**
 * Parse a TOML string for the subset Codex uses in environment files.
 * Supports comments, single-line basic strings with common escapes, and
 * triple-quoted multi-line literals (''' or """), plus [setup]/[cleanup]
 * tables and [[actions]] array-of-tables headers.
 */
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
			// Skip unreadable/corrupt files rather than breaking the extension.
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

/** Map Codex action icons to a small emoji set for the selector UI. */
function iconEmoji(icon?: string): string {
	switch (icon) {
		case "run":
			return "▶";
		case "test":
			return "🧪";
		case "debug":
			return "🐞";
		case "build":
			return "🔨";
		case "deploy":
			return "🚀";
		default:
			return "•";
	}
}

export default function (pi: ExtensionAPI) {
	// Resolved once at startup; used for /run completion before any handler runs.
	let startupEnvDir = findEnvironmentsDir(process.cwd());
	let startupActions = startupEnvDir ? collectActions(startupEnvDir) : [];

	const refresh = (ctx: ExtensionContext) => {
		const envDir = findEnvironmentsDir(ctx.cwd);
		if (envDir && envDir !== startupEnvDir) {
			startupEnvDir = envDir;
			startupActions = collectActions(envDir);
		}
		return { envDir, actions: envDir ? collectActions(envDir) : [] };
	};

	const runAction = async (
		action: EnvAction,
		envDir: string,
		signal?: AbortSignal,
		notify?: (msg: string, type: "info" | "warning" | "error") => void,
	): Promise<{ output: string; code: number }> => {
		const projectRoot = dirname(dirname(envDir)); // .codex/environments → project root
		notify?.(`▶ ${action.name}: ${action.command}`, "info");
		// Commands are shell strings; run them with bash in the project root.
		const result = await pi.exec("bash", ["-lc", action.command], { cwd: projectRoot, signal });
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		const status = result.code === 0 ? "done" : `exit code ${result.code}${result.killed ? " (killed)" : ""}`;
		notify?.(`${action.name}: ${status}`, result.code === 0 ? "info" : "error");
		return { output, code: result.code };
	};

	// Slash command: /run <action> — always registered, degrades gracefully.
	pi.registerCommand("run", {
		description: "Run a Codex environment action from .codex/environments/*.toml (e.g. /run simulator)",
		getArgumentCompletions: (prefix: string) => {
			const items = startupActions.map((a) => ({
				value: a.name,
				label: `${iconEmoji(a.icon)} ${a.name} — ${a.command}`,
			}));
			const lower = prefix.toLowerCase();
			const filtered = items.filter((i) => i.value.toLowerCase().startsWith(lower));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx: ExtensionCommandContext) => {
			const { envDir, actions } = refresh(ctx);
			if (!envDir || actions.length === 0) {
				ctx.ui.notify("No .codex/environments/*.toml actions found (searched from cwd upward)", "warning");
				return;
			}
			const want = args.trim().toLowerCase();
			let action = actions.find((a) => a.name.toLowerCase() === want);
			if (!action && want) {
				action = actions.find((a) => a.name.toLowerCase().startsWith(want));
			}
			if (!action) {
				if (!ctx.hasUI) {
					ctx.ui.notify("Usage: /run <action>", "warning");
					return;
				}
				const labels = actions.map((a) => `${iconEmoji(a.icon)} ${a.name} — ${a.command}`);
				const picked = await ctx.ui.select("Choose a Codex environment action", labels);
				if (!picked) return;
				action = actions[labels.indexOf(picked)];
			}
			if (!action) return;
			await runAction(action, envDir, undefined, ctx.ui.notify.bind(ctx.ui));
		},
	});

	// Model-callable tool. Registered on session_start so we know the real cwd.
	let toolRegistered = false;
	pi.on("session_start", (_event, ctx) => {
		if (toolRegistered) return;
		const envDir = findEnvironmentsDir(ctx.cwd);
		if (!envDir) return;
		const actions = collectActions(envDir);
		if (actions.length === 0) return;
		toolRegistered = true;
		startupEnvDir = envDir;
		startupActions = actions;

		pi.registerTool({
			name: "run_env_action",
			label: "Run Codex Environment Action",
			description:
				"Run a preset project action defined in .codex/environments/*.toml (e.g. running an iOS simulator, Android device, or dev server). Read .codex/environments/*.toml to find action names, then call this tool.",
			promptSnippet: "Run a preset project action (run_env_action)",
			promptGuidelines: [
				"Use run_env_action when the user asks to run a preset project action (simulator, device, dev server, tests) defined in .codex/environments/*.toml.",
			],
			parameters: Type.Object({
				action: StringEnum(actions.map((a) => a.name) as [string, ...string[]]),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, toolCtx) {
				const { envDir, actions: currentActions } = refresh(toolCtx);
				const current =
					currentActions.find((a) => a.name === params.action) ??
					actions.find((a) => a.name === params.action);
				if (!current || !envDir) {
					return {
						content: [{ type: "text", text: `Action not found: ${params.action}` }],
						details: {},
					};
				}
				const { output, code } = await runAction(current, envDir, signal ?? undefined);
				return {
					content: [{ type: "text", text: output || "(no output)" }],
					details: { action: params.action, exitCode: code },
				};
			},
		});
	});
}
