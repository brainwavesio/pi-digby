import { type BuiltinProvider, getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { DigbyConfig } from "../config.js";

export function resolveConfiguredModel(provider: string, modelId: string) {
	const model = getBuiltinModel(provider as BuiltinProvider, modelId as never);
	if (!model) throw new Error(`Unknown model ${provider}/${modelId}; check the installed SDK registry.`);
	if (!(model.contextWindow > 0)) throw new Error(`Model ${provider}/${modelId} has no valid context window.`);
	return model;
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Bedrock request object");
	return value as Record<string, unknown>;
}

/** Sonnet 5.5 no longer accepts disabled thinking or forced tool selection. */
export function prepareBedrockPayload(payload: unknown, level: DigbyConfig["thinkingLevel"]) {
	const request = record(payload);
	const toolConfig = request.toolConfig === undefined ? {} : record(request.toolConfig);
	const choice = toolConfig.toolChoice === undefined ? {} : record(toolConfig.toolChoice);
	if ("any" in choice || "tool" in choice)
		throw new Error("Sonnet 5.5 does not support forced tool use; select auto.");
	const inferenceConfig = { ...record(request.inferenceConfig ?? {}) };
	delete inferenceConfig.temperature;
	delete inferenceConfig.topP;
	const fields = { ...record(request.additionalModelRequestFields ?? {}) };
	delete fields.top_k;
	delete fields.temperature;
	delete fields.top_p;
	const effort = !level || level === "off" || level === "minimal" ? "low" : level;
	fields.thinking = { type: !level || level === "off" ? "between_tools" : "adaptive" };
	fields.output_config = { ...record(fields.output_config ?? {}), effort };
	return { ...request, inferenceConfig, additionalModelRequestFields: fields };
}
