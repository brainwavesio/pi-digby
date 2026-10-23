import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createRequire } from "module";

/**
 * Load the pi-mcp-adapter extension factory. The package ships TypeScript source, so jiti loads it.
 */
export async function loadMcpAdapter(): Promise<ExtensionFactory> {
	const { createJiti } = await import("jiti");
	const jiti = createJiti(import.meta.url);
	return jiti.import(createRequire(import.meta.url).resolve("pi-mcp-adapter"), { default: true });
}
