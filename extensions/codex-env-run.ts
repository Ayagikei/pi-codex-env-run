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
import { execStreaming, formatDuration } from "../src/exec-streaming.ts";

/** Widget status refresh interval while an action is running. */
const HEARTBEAT_MS = 1_000;
/** Non-TUI notify heartbeats stay at 10s so they don't spam the transcript/event stream. */
const NOTIFY_HEARTBEAT_EVERY = 10;
/** Only ping the tool row with elapsed time when output has been silent this long. */
const SILENT_UPDATE_MS = 5_000;

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
		onUpdate?: (tail: string, elapsedMs: number) => void,
		onHeartbeat?: (elapsed: string, lastLine: string) => void,
	): Promise<{ output: string; code: number }> => {
		const projectRoot = dirname(dirname(envDir)); // .codex/environments → project root
		const startedAt = Date.now();
		notify?.(`▶ ${action.name}: ${action.command}`, "info");

		let lastLine = "";
		let lastOutputAt = Date.now();
		const forwardUpdate = (tail: string, elapsedMs: number) => {
			lastOutputAt = Date.now();
			if (tail) {
				const lines = tail.trimEnd().split("\n");
				lastLine = lines[lines.length - 1].slice(0, 120);
			}
			onUpdate?.(tail, elapsedMs);
		};
		// Long-running actions: keep a live status line (elapsed time + latest
		// output line) and, when output is silent, ping the tool row too. With
		// onHeartbeat the status goes to a fixed widget instead of notify spam.
		// First tick runs immediately so the status shows at 0s, not after the
		// first interval.
		let tickCount = 0;
		const tick = () => {
			tickCount++;
			const elapsed = formatDuration(Date.now() - startedAt);
			if (onHeartbeat) {
				onHeartbeat(elapsed, lastLine);
			} else if (tickCount % NOTIFY_HEARTBEAT_EVERY === 1) {
				notify?.(`⏱ ${action.name}: running for ${elapsed}${lastLine ? ` · ${lastLine}` : ""}`, "info");
			}
			if (onUpdate && Date.now() - lastOutputAt > SILENT_UPDATE_MS) {
				onUpdate("", Date.now() - startedAt);
			}
		};
		const heartbeat = notify || onUpdate || onHeartbeat
			? (tick(), setInterval(tick, HEARTBEAT_MS))
			: undefined;
		try {
			// Commands are shell strings; run them with bash in the project root,
			// streaming the latest output instead of buffering until exit.
			const result = await execStreaming(action.command, projectRoot, signal, notify || onUpdate ? forwardUpdate : undefined);
			const duration = formatDuration(Date.now() - startedAt);
			const status =
				result.code === 0
					? `done in ${duration}`
					: `exit code ${result.code}${result.killed ? " (killed)" : ""} after ${duration}`;
			// Failures usually hide their reason in the last output lines; attach a
			// short tail so the completion notice says why it failed, not just the code.
			const tail = result.output
				.trimEnd()
				.split("\n")
				.slice(-5)
				.map((l) => l.slice(0, 160))
				.join("\n");
			notify?.(
				`${action.name}: ${status}${result.code !== 0 && tail ? `\n${tail}` : ""}`,
				result.code === 0 ? "info" : "error",
			);
			return { output: result.output, code: result.code };
		} finally {
			if (heartbeat) clearInterval(heartbeat);
		}
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
			const target = action;
			// TUI: live status in a fixed widget (same spot as the todo list) so
			// heartbeat lines don't spam the transcript; non-TUI falls back to
			// notify heartbeats. The completion notify below stays in the transcript.
			const useWidget = ctx.mode === "tui";
			try {
				await runAction(
					target,
					envDir,
					undefined,
					ctx.ui.notify.bind(ctx.ui),
					undefined,
					useWidget
						? (elapsed, lastLine) =>
								ctx.ui.setWidget(
									"codex-env-run:status",
									[`⏱ ${target.name}: running for ${elapsed}${lastLine ? ` · ${lastLine}` : ""}`],
									{ placement: "aboveEditor" },
								)
						: undefined,
				);
			} finally {
				if (useWidget) ctx.ui.setWidget("codex-env-run:status", undefined);
			}
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
			async execute(_toolCallId, params, signal, onUpdate, toolCtx) {
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
				const startedAt = Date.now();
				// Flip the tool row into live/pending mode right away (like the built-in
				// bash tool) so a silent command still shows it is running.
				onUpdate?.({ content: [], details: {} });
				const { output, code } = await runAction(current, envDir, signal ?? undefined, undefined, (tail, elapsedMs) => {
					const text = [tail.trimEnd(), `⏱ ${formatDuration(elapsedMs)}`].filter(Boolean).join("\n");
					onUpdate?.({ content: [{ type: "text", text }], details: {} });
				});
				return {
					content: [{ type: "text", text: output || "(no output)" }],
					details: { action: params.action, exitCode: code, durationMs: Date.now() - startedAt },
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
