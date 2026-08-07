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
import { collectActions, findEnvironmentsDir, type EnvAction } from "../src/parser.ts";

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
