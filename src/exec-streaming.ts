/**
 * Streaming command execution for run_env_action / /run.
 *
 * Dependency-free (node builtins only) so it stays unit-testable like
 * src/parser.ts. Unlike pi.exec — which buffers all output until the process
 * exits — this pushes throttled snapshots of the latest output while the
 * command is running, so the UI can show live progress and elapsed time.
 */
import { spawn } from "node:child_process";

/** Human-readable duration, e.g. "42s", "3m 12s". */
export function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m ${s % 60}s`;
}

export interface ExecStreamingResult {
	output: string;
	code: number;
	killed: boolean;
}

const UPDATE_THROTTLE_MS = 250;
const TAIL_LIMIT = 4096;
/** Re-arm deadline for output arriving after the process exited (see below). */
const EXIT_STDIO_GRACE_MS = 100;
/** Escalate to SIGKILL if the child ignores SIGTERM. */
const SIGKILL_AFTER_MS = 5000;

/**
 * Run `bash -lc <command>` in `cwd`.
 *
 * `onUpdate(tail, elapsedMs)` is called at most every UPDATE_THROTTLE_MS with
 * the latest output (capped to TAIL_LIMIT chars) and time since start.
 *
 * Resolves when the process exits AND its output pipes fall idle, so a
 * detached descendant holding a pipe open can't hang the caller forever:
 * after exit, the idle timer is re-armed on every chunk, so an actively
 * writing descendant keeps us reading while a quiet inherited handle still
 * releases us once the grace elapses.
 *
 * `signal` aborts with SIGTERM, then SIGKILL if ignored. Spawn failures
 * resolve with `code: 1` (matching pi.exec semantics).
 */
export function execStreaming(
	command: string,
	cwd: string,
	signal?: AbortSignal,
	onUpdate?: (tail: string, elapsedMs: number) => void,
): Promise<ExecStreamingResult> {
	return new Promise((resolve) => {
		const child = spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });

		let killed = false;
		const killProcess = () => {
			if (killed) return;
			killed = true;
			child.kill("SIGTERM");
			setTimeout(() => {
				// child.killed is already true after the SIGTERM; only escalate if the
				// process actually hasn't exited yet.
				if (child.exitCode === null) child.kill("SIGKILL");
			}, SIGKILL_AFTER_MS);
		};
		if (signal) {
			if (signal.aborted) killProcess();
			else signal.addEventListener("abort", killProcess, { once: true });
		}

		let all = "";
		let tail = "";
		let dirty = false;
		let updateTimer: NodeJS.Timeout | undefined;
		const startedAt = Date.now();
		const emitUpdate = () => {
			if (!onUpdate || !dirty) return;
			dirty = false;
			onUpdate(tail, Date.now() - startedAt);
		};
		const scheduleUpdate = () => {
			if (!onUpdate) return;
			dirty = true;
			if (updateTimer) return;
			updateTimer = setTimeout(() => {
				updateTimer = undefined;
				emitUpdate();
			}, UPDATE_THROTTLE_MS);
		};
		const flushUpdate = () => {
			if (updateTimer) {
				clearTimeout(updateTimer);
				updateTimer = undefined;
			}
			emitUpdate();
		};

		let exited = false;
		let exitCode: number | null = null;
		let spawnError = false;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;
		let settled = false;
		let idleTimer: NodeJS.Timeout | undefined;
		const finish = () => {
			if (settled) return;
			settled = true;
			if (idleTimer) clearTimeout(idleTimer);
			signal?.removeEventListener("abort", killProcess);
			child.stdout?.destroy();
			child.stderr?.destroy();
			flushUpdate();
			resolve({ output: all, code: killed ? 1 : (exitCode ?? 0), killed });
		};
		const maybeFinish = () => {
			if (exited && stdoutEnded && stderrEnded) finish();
		};
		const armIdle = () => {
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(finish, EXIT_STDIO_GRACE_MS);
		};
		const onData = (chunk: Buffer) => {
			const text = chunk.toString();
			all += text;
			tail = (tail + text).slice(-TAIL_LIMIT);
			scheduleUpdate();
			if (exited && !settled) armIdle();
		};
		child.stdout?.once("end", () => {
			stdoutEnded = true;
			maybeFinish();
		});
		child.stderr?.once("end", () => {
			stderrEnded = true;
			maybeFinish();
		});
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", () => {
			spawnError = true;
			exited = true;
			exitCode = 1;
			maybeFinish();
			armIdle();
		});
		child.once("exit", (code) => {
			exited = true;
			exitCode = code;
			maybeFinish();
			armIdle();
		});
		child.once("close", (code) => {
			if (!spawnError) exitCode = code;
			finish();
		});
	});
}
