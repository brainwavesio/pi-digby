import { describe, expect, it } from "vitest";
import { configuredStreamOptions, prepareBedrockPayload, resolveConfiguredModel } from "../src/agent/model.js";

describe("configured Bedrock models", () => {
 it("resolves Sonnet 5.5 and the Opus rollback with valid compaction metadata", () => {
  for (const id of ["us.anthropic.claude-sonnet-5-5", "us.anthropic.claude-opus-5"]) {
   const model = resolveConfiguredModel("amazon-bedrock", id);
   expect(model.id).toBe(id);
   expect(model.contextWindow).toBeGreaterThan(0);
  }
 });
 it("fails clearly for a missing model instead of silently selecting another", () => {
  expect(() => resolveConfiguredModel("amazon-bedrock", "missing")).toThrow(/Unknown model/);
 });
 it("maps off to between-tools at low effort without prohibited sampling fields", () => {
  const result = prepareBedrockPayload({ inferenceConfig: { maxTokens: 2000, temperature: 1, topP: .9 } }, "off");
  expect(result).toMatchObject({ inferenceConfig: { maxTokens: 2000 }, additionalModelRequestFields: {
   thinking: { type: "between_tools" }, output_config: { effort: "low" }
  } });
  expect(result.inferenceConfig).not.toHaveProperty("temperature");
  expect(result.inferenceConfig).not.toHaveProperty("topP");
 });
 it("rejects forced tool use instead of silently changing its contract", () => {
  expect(() => prepareBedrockPayload({ toolConfig: { toolChoice: { any: {} } } }, "off")).toThrow(/forced tool/);
 });
 it("uses adaptive thinking for higher effort and removes unsupported thinking fields", () => {
  expect(prepareBedrockPayload({ additionalModelRequestFields: { thinking: { type: "disabled", budget_tokens: 3000 } } }, "max"))
   .toMatchObject({ additionalModelRequestFields: { thinking: { type: "adaptive" }, output_config: { effort: "max" } } });
 });
});

it("preserves adaptive thinking replay protection", () => {
 expect(prepareBedrockPayload({ additionalModelRequestFields: { thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } } } }, "high")).toMatchObject({ additionalModelRequestFields: { thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } } } });
});

it("adapts Sonnet stream options after the caller hook and skips the Opus rollback", async () => {
 const sonnet = resolveConfiguredModel("amazon-bedrock", "us.anthropic.claude-sonnet-5-5");
 const opus = resolveConfiguredModel("amazon-bedrock", "us.anthropic.claude-opus-5");
 let called = false;
 const options = { onPayload: () => { called = true; return { inferenceConfig: { maxTokens: 123, temperature: 1 } }; } };
 const result = await configuredStreamOptions(sonnet, options, "off")?.onPayload?.({}, sonnet);
 expect(called).toBe(true);
 expect(result).toMatchObject({ inferenceConfig: { maxTokens: 123 }, additionalModelRequestFields: { thinking: { type: "between_tools" } } });
 expect(result).not.toHaveProperty("inferenceConfig.temperature");
 expect(configuredStreamOptions(opus, options, "off")).toBe(options);
 expect(configuredStreamOptions({ ...sonnet, provider: "anthropic" }, options, "off")).toBe(options);
 expect(await configuredStreamOptions(sonnet, { onPayload: () => undefined }, "off")?.onPayload?.({ inferenceConfig: { maxTokens: 321 } }, sonnet)).toMatchObject({ inferenceConfig: { maxTokens: 321 } });
});
