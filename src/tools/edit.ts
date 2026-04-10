import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import * as Diff from "diff";
import { readFileSync, writeFileSync } from "fs";

/**
 * Generate a unified diff string with line numbers and context.
 * Copied from pi-mom (v0.65.0) — src/tools/edit.ts
 */
function generateDiffString(oldContent: string, newContent: string, contextLines = 4): string {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);

			if (lastWasChange || nextPartIsChange) {
				let linesToShow = raw;
				let skipStart = 0;
				let skipEnd = 0;

				if (!lastWasChange) {
					skipStart = Math.max(0, raw.length - contextLines);
					linesToShow = raw.slice(skipStart);
				}

				if (!nextPartIsChange && linesToShow.length > contextLines) {
					skipEnd = linesToShow.length - contextLines;
					linesToShow = linesToShow.slice(0, contextLines);
				}

				if (skipStart > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				}

				for (const line of linesToShow) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skipEnd > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				}

				oldLineNum += skipStart + skipEnd;
				newLineNum += skipStart + skipEnd;
			} else {
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return output.join("\n");
}

const editItemSchema = Type.Object({
	old_text: Type.String({ description: "Exact text to find and replace" }),
	new_text: Type.String({ description: "Replacement text" }),
});

export function createEditTool(): AgentTool<any> {
	const schema = Type.Object({
		label: Type.String({ description: "Brief description (shown to user)" }),
		path: Type.String({ description: "Absolute path to the file" }),
		old_text: Type.Optional(Type.String({ description: "Exact text to find and replace (single edit mode)" })),
		new_text: Type.Optional(Type.String({ description: "Replacement text (single edit mode)" })),
		edits: Type.Optional(
			Type.Array(editItemSchema, { description: "Replacements to apply sequentially (batched mode)" }),
		),
	});

	return {
		name: "edit",
		label: "edit",
		description:
			"Replace exact text in a file. Use old_text/new_text for a single replacement, or edits[] for multiple replacements in one call. Each old_text must appear exactly once.",
		parameters: schema,
		execute: async (_toolCallId, { path, old_text, new_text, edits }, signal, _onUpdate?) => {
			if (signal?.aborted) throw new Error("Aborted");

			const originalContent = readFileSync(path, "utf-8");
			let currentContent = originalContent;

			if (edits !== undefined) {
				for (const edit of edits) {
					const occurrences = currentContent.split(edit.old_text).length - 1;
					if (occurrences === 0) {
						throw new Error(`Text not found in ${path}`);
					}
					if (occurrences > 1) {
						throw new Error(`Text found ${occurrences} times in ${path} — must be unique`);
					}
					currentContent = currentContent.replace(edit.old_text, edit.new_text);
				}
			} else {
				if (old_text === undefined || new_text === undefined) {
					throw new Error("Either edits[] or both old_text and new_text must be provided");
				}
				const occurrences = currentContent.split(old_text).length - 1;
				if (occurrences === 0) {
					throw new Error(`Text not found in ${path}`);
				}
				if (occurrences > 1) {
					throw new Error(`Text found ${occurrences} times in ${path} — must be unique`);
				}
				currentContent = currentContent.replace(old_text, new_text);
			}

			writeFileSync(path, currentContent);

			const diff = generateDiffString(originalContent, currentContent);
			return {
				content: [{ type: "text" as const, text: `Edited ${path}\n\n${diff}` }],
				details: undefined,
			};
		},
	};
}
