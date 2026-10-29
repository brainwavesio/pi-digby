import { describe, expect, it, vi } from "vitest";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { createRunStats } from "../src/channel/run-stats.js";
import { recordAssistantUsage } from "../src/persistence/run-usage.js";
import { Type } from "typebox";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { prepareBedrockPayload, resolveConfiguredModel } from "../src/agent/model.js";

describe("Bedrock SDK request boundary", () => {
 it("constructs a Sonnet tool request, strips cross-model thinking and handles transport failure without inference", async () => {
  const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockRejectedValue(new Error("offline test"));
  try {
   const model = resolveConfiguredModel("amazon-bedrock", "us.anthropic.claude-sonnet-5-5");
   const stream = bedrockProviderModule.streamSimple(model, normalizeContext({ messages: [
    { role: "system", content: "test instructions", toolsAdded: [{ name: "read", description: "read a file", parameters: Type.Object({ path: Type.String() }) }] },
    { role: "user", content: "test", timestamp: 0 },
    { role: "assistant", provider: "amazon-bedrock", api: "bedrock-converse-stream", model: "us.anthropic.claude-opus-5",
      content: [{ type: "thinking", thinking: "old thinking", thinkingSignature: "old-signature" }, { type: "text", text: "old reply" }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 },
    { role: "user", content: "continue", timestamp: 1 }
   ] }), { env: {}, onPayload: payload => prepareBedrockPayload(payload, "off") });
   const result = await stream.result();
   expect(result.stopReason).toBe("error");
const stats = createRunStats();
recordAssistantUsage(stats, result);
expect(stats.usage).toEqual({ models: [], missingCalls: 1 });
   expect(result.errorMessage).toContain("offline test");
   expect(send).toHaveBeenCalledOnce();
   const request = send.mock.calls[0][0].input;
   expect(request).toMatchObject({ modelId: model.id, additionalModelRequestFields: { thinking: { type: "between_tools" }, output_config: { effort: "low" } } });
   expect(JSON.stringify(request)).not.toMatch(/old-signature|old thinking/);
   expect(JSON.stringify(request)).toContain("old reply");
   expect(request.toolConfig).toBeDefined();
  } finally { send.mockRestore(); }
 });
});
