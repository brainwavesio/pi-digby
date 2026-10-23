import { describe, expect, it } from "vitest";
import { loadMcpAdapter } from "../src/agent/mcp-adapter.js";

describe("MCP adapter", () => {
	it("loads the installed pi-mcp-adapter extension factory", async () => {
		expect(await loadMcpAdapter()).toBeTypeOf("function");
	});
});
