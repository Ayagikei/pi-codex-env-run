/**
 * Streaming exec tests for pi-codex-env-run.
 * Run with: node --test tests/exec-streaming.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execStreaming, formatDuration } from "../src/exec-streaming.ts";

test("formatDuration renders seconds and minutes", () => {
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(42_000), "42s");
	assert.equal(formatDuration(192_000), "3m 12s");
});

test("returns stdout, merges stderr, and reports exit code", async () => {
	const result = await execStreaming("echo hello; echo oops >&2; exit 3", process.cwd());
	assert.equal(result.code, 3);
	assert.equal(result.output, "hello\noops\n");
});

test("streams throttled latest output with elapsed time", async () => {
	const updates = [];
	const result = await execStreaming(
		"for i in 1 2 3; do echo line-$i; sleep 0.15; done",
		process.cwd(),
		undefined,
		(tail, elapsedMs) => updates.push({ tail, elapsedMs }),
	);
	assert.equal(result.code, 0);
	// Throttled to ~250ms: 3 lines over ~450ms should produce 2-3 snapshots,
	// never one per line.
	assert.ok(updates.length >= 1 && updates.length <= 2, `expected 1-2 updates, got ${updates.length}`);
	const last = updates[updates.length - 1];
	assert.ok(last.tail.includes("line-3"), `last tail should contain final line: ${last.tail}`);
	assert.ok(last.elapsedMs >= 0);
});

test("abort kills a long-running command and reports killed", async () => {
	const controller = new AbortController();
	const promise = execStreaming("sleep 30", process.cwd(), controller.signal);
	setTimeout(() => controller.abort(), 200);
	const result = await promise;
	assert.equal(result.killed, true);
	assert.notEqual(result.code, 0);
});

test("SIGKILL escalation stops a command that ignores SIGTERM", async () => {
	const controller = new AbortController();
	const promise = execStreaming('trap "" TERM; while true; do sleep 1; done', process.cwd(), controller.signal);
	setTimeout(() => controller.abort(), 200);
	const startedAt = Date.now();
	const result = await promise;
	assert.equal(result.killed, true);
	assert.ok(Date.now() - startedAt >= 4500, "should escalate to SIGKILL after the 5s grace");
});

test("resolves promptly when a detached descendant holds the output pipe", async () => {
	// The script backgrounds a child that keeps stdout open and then exits.
	// execStreaming must not hang on the inherited pipe.
	const startedAt = Date.now();
	const result = await execStreaming("sleep 2 > /tmp/pi-coder-env-run-detached.log & exit 0", process.cwd());
	assert.equal(result.code, 0);
	assert.ok(Date.now() - startedAt < 2000, "should resolve ~immediately, not wait for the background child");
});
