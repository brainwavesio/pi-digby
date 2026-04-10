import { randomBytes } from "crypto";
import { readFileSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditTool } from "../src/tools/edit.js";
import { createLoadResourceTool } from "../src/tools/load-resource.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempFiles: string[] = [];

function makeTempFile(content: string): string {
	const path = join(tmpdir(), `tools-test-${randomBytes(6).toString("hex")}.txt`);
	writeFileSync(path, content, "utf-8");
	tempFiles.push(path);
	return path;
}

afterEach(() => {
	for (const path of tempFiles.splice(0)) {
		try {
			unlinkSync(path);
		} catch {
			// ignore missing files
		}
	}
});

// ---------------------------------------------------------------------------
// edit tool
// ---------------------------------------------------------------------------

describe("edit tool", () => {
	it("single replacement (existing behavior)", async () => {
		const path = makeTempFile("hello world");
		const tool = createEditTool();
		const result = await tool.execute("id", { label: "test", path, old_text: "world", new_text: "there" }, undefined);
		expect(result.content[0].text).toContain(`Edited ${path}`);
		expect(readFileSync(path, "utf-8")).toBe("hello there");
	});

	it("batched replacements via edits array", async () => {
		const path = makeTempFile("foo bar baz");
		const tool = createEditTool();
		const result = await tool.execute(
			"id",
			{
				label: "test",
				path,
				edits: [
					{ old_text: "foo", new_text: "qux" },
					{ old_text: "bar", new_text: "quux" },
				],
			},
			undefined,
		);
		expect(result.content[0].text).toContain(`Edited ${path}`);
		expect(readFileSync(path, "utf-8")).toBe("qux quux baz");
	});

	it("error when old_text not found", async () => {
		const path = makeTempFile("hello world");
		const tool = createEditTool();
		await expect(
			tool.execute("id", { label: "test", path, old_text: "notfound", new_text: "x" }, undefined),
		).rejects.toThrow("Text not found");
	});

	it("error when old_text appears more than once", async () => {
		const path = makeTempFile("foo foo");
		const tool = createEditTool();
		await expect(
			tool.execute("id", { label: "test", path, old_text: "foo", new_text: "bar" }, undefined),
		).rejects.toThrow("must be unique");
	});

	it("error when a batch edit old_text not found", async () => {
		const path = makeTempFile("hello world");
		const tool = createEditTool();
		await expect(
			tool.execute(
				"id",
				{
					label: "test",
					path,
					edits: [{ old_text: "notfound", new_text: "x" }],
				},
				undefined,
			),
		).rejects.toThrow("Text not found");
	});
});

// ---------------------------------------------------------------------------
// load_resource tool
// ---------------------------------------------------------------------------

describe("load_resource tool", () => {
	it("returns content for a known resource ID", async () => {
		const registry = new Map([["my-skill", () => "skill content here"]]);
		const tool = createLoadResourceTool(registry);
		const result = await tool.execute("id", { label: "test", resource_id: "my-skill" }, undefined);
		expect(result.content[0].text).toBe("skill content here");
	});

	it("returns error with available IDs for unknown resource ID", async () => {
		const registry = new Map([
			["skill-a", () => "content a"],
			["skill-b", () => "content b"],
		]);
		const tool = createLoadResourceTool(registry);
		const result = await tool.execute("id", { label: "test", resource_id: "unknown" }, undefined);
		expect(result.content[0].text).toContain("not found");
		expect(result.content[0].text).toContain("skill-a");
		expect(result.content[0].text).toContain("skill-b");
	});

	it("works with an empty registry (returns error listing 0 resources)", async () => {
		const registry = new Map<string, () => string>();
		const tool = createLoadResourceTool(registry);
		const result = await tool.execute("id", { label: "test", resource_id: "anything" }, undefined);
		expect(result.content[0].text).toContain("not found");
		expect(result.content[0].text).toContain("(none)");
	});
});
