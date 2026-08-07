/**
 * pi-codex-env-run
 *
 * Reuse Codex project environments (.codex/environments/*.toml) inside pi.
 *
 * Codex stores project-local run actions in TOML files under
 * `.codex/environments/` (canonical name: environment.toml). This extension
 * parses those files (see src/parser.ts) and exposes the actions to pi as:
 *
 *   - `/run <action>`  slash command with action-name completion
 *   - `run_env_action` tool callable by the model
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { dirname } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	addActionToToml,
	collectActions,
	findEnvironmentsDir,
	parseEnvironmentToml,
	removeActionFromToml,
	resolveEnvFile,
	type EnvAction,
	updateActionInToml,
	validateEnvironmentDir,
	validateEnvironmentToml,
	writeEnvironmentFile,
} from "../src/parser.ts";

/** Per-file validation issues for every TOML in an environment directory. */
function loadEnvFilesForValidation(envDir: string): ReturnType<typeof validateEnvironmentToml>[] {
	const all: ReturnType<typeof validateEnvironmentToml>[] = [];
	let files: string[] = [];
	try {
		files = readdirSync(envDir).filter((f) => f.endsWith(".toml")).sort();
	} catch {
		return all;
	}
	for (const f of files) {
		try {
			all.push(...validateEnvironmentToml(readFileSync(join(envDir, f), "utf8")));
		} catch {
			// skip unreadable files
		}
	}
	return all.flat();
}

/** Extract action names from a TOML document (for duplicate checks). */
function parseTomlForCheck(toml: string): string[] {
	return parseEnvironmentToml(toml, "environment.toml").actions.map((a) => a.name);
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

		// Management tool: list / validate / add / update / remove env actions.
		pi.registerTool({
			name: "manage_env_action",
			label: "Manage Codex Environment Actions",
			description:
				"List, validate, add, update or remove actions in .codex/environments/*.toml. " +
				"validate reports TOML/required-field/duplicate/icon problems without running commands; " +
				"add/update/remove edit the TOML block-precise (comments and other content are preserved). " +
				"Use list first to discover existing action names.",
			promptSnippet: "Manage preset project actions (manage_env_action)",
			promptGuidelines: [
				"Use manage_env_action to list, validate, add, update or remove preset actions in .codex/environments/*.toml.",
				"Run validate after any add/update/remove to confirm the file is still valid.",
			],
			parameters: Type.Object({
				operation: StringEnum(["list", "validate", "add", "update", "remove"] as const),
				name: Type.Optional(Type.String({ description: "Action name (required for add/update/remove)" })),
				command: Type.Optional(Type.String({ description: "Shell command (required for add/update)" })),
				icon: Type.Optional(Type.String({ description: "Codex action icon, e.g. run/test/debug (add/update)" })),
				file: Type.Optional(
					Type.String({ description: "Target .toml filename inside .codex/environments (default environment.toml)" }),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, toolCtx) {
				const { envDir } = refresh(toolCtx);
				if (!envDir) {
					return {
						content: [{ type: "text", text: "No .codex/environments directory found (searched from cwd upward)" }],
						details: {},
					};
				}

				// list / validate operate on the whole directory.
				if (params.operation === "list" || params.operation === "validate") {
					if (params.operation === "list") {
						const list = collectActions(envDir);
						if (list.length === 0) {
							return { content: [{ type: "text", text: "No actions found in .codex/environments/*.toml" }], details: {} };
					}
					const text = list
						.map((a) => `- ${a.name}${a.icon ? ` [${a.icon}]` : ""} (${a.file})\n    ${a.command}`)
						.join("\n");
					return { content: [{ type: "text", text: text }], details: { count: list.length } };
				}

				// validate: per-file + cross-file issues.
				const issues = [
					...validateEnvironmentDir(envDir),
					...loadEnvFilesForValidation(envDir),
				];				if (issues.length === 0) {
					return {
						content: [{ type: "text", text: "Validation passed: no issues found." }],
						details: { issues: 0 },
					};
				}
				const text = issues.map((i) => `[${i.level.toUpperCase()}] ${i.message}${i.line ? ` (line ${i.line})` : ""}`).join("\n");
				return {
					content: [{ type: "text", text: text }],
					details: { issues: issues.length, errors: issues.filter((i) => i.level === "error").length },
				};
			}

			// add / update / remove target a single file (default environment.toml).
			const fileName = params.file ?? "environment.toml";
			const file = resolveEnvFile(envDir, fileName);
			if (!file) {
				return {
					content: [{ type: "text", text: `Target file not found: ${fileName} (must be a .toml inside ${envDir})` }],
					details: {},
				};
			}
			const toml = readFileSync(file, "utf8");
			const name = params.name?.trim();

			if (params.operation === "add") {
				if (!name) {
					return { content: [{ type: "text", text: "add requires a non-empty name" }], details: {} };
				}
				if (!params.command?.trim()) {
					return { content: [{ type: "text", text: "add requires a non-empty command" }], details: {} };
				}
				// Reject duplicates within the target file.
				const existing = parseTomlForCheck(toml);
				if (existing.some((n) => n.toLowerCase() === name.toLowerCase())) {
					return {
						content: [{ type: "text", text: `Action "${name}" already exists in ${fileName}; use update instead` }],
						details: {},
					};
				}
				const updated = addActionToToml(toml, { name, icon: params.icon, command: params.command });
				writeEnvironmentFile(file, updated);
				return {
					content: [{ type: "text", text: `Added action "${name}" to ${fileName}. Run validate to confirm.` }],
					details: { file: fileName },
				};
			}

			if (params.operation === "update") {
				if (!name) {
					return { content: [{ type: "text", text: "update requires a non-empty name" }], details: {} };
				}
				if (!params.command?.trim()) {
					return { content: [{ type: "text", text: "update requires a non-empty command" }], details: {} };
				}
				const updated = updateActionInToml(toml, name, { icon: params.icon, command: params.command });
				if (updated === null) {
					return {
						content: [{ type: "text", text: `Action "${name}" not found in ${fileName}` }],
						details: {},
					};
				}
				writeEnvironmentFile(file, updated);
				return {
					content: [{ type: "text", text: `Updated action "${name}" in ${fileName}. Run validate to confirm.` }],
					details: { file: fileName },
				};
			}

			// remove
			if (!name) {
				return { content: [{ type: "text", text: "remove requires a non-empty name" }], details: {} };
			}
			const updated = removeActionFromToml(toml, name);
			if (updated === null) {
				return {
					content: [{ type: "text", text: `Action "${name}" not found in ${fileName}` }],
					details: {},
				};
			}
			writeEnvironmentFile(file, updated);
			return {
				content: [{ type: "text", text: `Removed action "${name}" from ${fileName}. Run validate to confirm.` }],
				details: { file: fileName },
			};
		},
	});
});
}
