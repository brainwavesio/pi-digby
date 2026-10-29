import { describe, expect, it } from "vitest";
import { prepareBedrockPayload, resolveConfiguredModel } from "../src/agent/model.js";

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
