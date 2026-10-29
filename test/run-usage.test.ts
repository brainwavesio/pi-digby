import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { createRunStats } from "../src/channel/run-stats.js";
import { recordAssistantUsage, writeRunUsage } from "../src/persistence/run-usage.js";

describe("durable run usage", () => {
 it("records silent usage without response, prompt or error contents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "digby-usage-"));
  try {
   const stats = createRunStats();
   stats.lastStreamedText = "private response";
   stats.errorMessage = "secret error";
   recordAssistantUsage(stats, { provider: "amazon-bedrock", model: "us.anthropic.claude-opus-5", usage: {
    input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: { total: .025 }
   } });
   const path = await writeRunUsage(dir, { runId: "test", source: "slack", channelId: "C1", jobId: "sync.json", startedAt: 1 }, stats, true);
   const raw = await readFile(path, "utf8");
   const saved = JSON.parse(raw);
   expect(saved.silent).toBe(true);
   expect(saved.models[0]).toMatchObject({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, estimatedCostUsd: .025 });
   expect(raw).not.toMatch(/private response|secret error/);
  } finally { await rm(dir, { recursive: true, force: true }); }
 });
 it("marks unavailable usage instead of reporting a measured zero", () => {
  const stats = createRunStats();
  recordAssistantUsage(stats, { provider: "amazon-bedrock", model: "test" });
  expect(stats.usage?.missingCalls).toBe(1);
  expect(stats.usage?.models).toEqual([]);
 });
});

it("does not count SDK placeholder zeros after a failed stream as measured usage", () => {
 const stats = createRunStats();
 recordAssistantUsage(stats, { provider: "amazon-bedrock", model: "test", stopReason: "error", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } });
 expect(stats.usage).toEqual({ models: [], missingCalls: 1 });
});

it("captures compaction usage through the session event interface without recording its summary", async () => {
 const { createEventHandler } = await import("../src/agent/events.js");
 const stats = createRunStats();
 const surface = { emitThinking() {}, emitProgress() {}, emitResponse() {}, emitDetail() {}, emitReaction() {}, emitFile() {}, resolve() {}, reject() {}, suppress() {}, async flush() {}, dispose() {}, finalText: "", finalMessageTs: null, wasDeleted: false };
 const handler = createEventHandler(surface, "C1", stats);
 handler({ type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: "private failure" });
 handler({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false, result: {
  summary: "private summary", firstKeptEntryId: "id", tokensBefore: 1000,
  usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: .001, output: .002, cacheRead: 0, cacheWrite: 0, total: .003 } }
 } });
 expect(stats.usage?.models[0]).toMatchObject({ purpose: "compaction", model: "not-reported", input: 100, output: 10, estimatedCostUsd: .003 });
 expect(JSON.stringify(stats.usage)).not.toContain("private summary");
 handler({ type: "compaction_end", reason: "threshold", aborted: true, willRetry: false, result: undefined });
 expect(stats.usage?.missingCalls).toBe(2);
});
