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
