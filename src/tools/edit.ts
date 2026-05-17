import type { AgentTool } from "@earendil-works/pi-agent-core";
import * as Diff from "diff";
import { readFileSync, writeFileSync } from "fs";
import { Type } from "typebox";

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

const editSchema = Type.Object({
	label: Type.String({ description: "Brief description (shown to user)" }),
	path: Type.String({ description: "Absolute path to the file" }),
	old_text: Type.String({ description: "Exact text to find and replace" }),
	new_text: Type.String({ description: "Replacement text" }),
});

export function createEditTool(): AgentTool<typeof editSchema> {
	return {
		name: "edit",
		label: "edit",
		description: "Replace exact text in a file. The old_text must appear exactly once.",
		parameters: editSchema,
		execute: async (_toolCallId, { path, old_text, new_text }, signal, _onUpdate?) => {
			if (signal?.aborted) throw new Error("Aborted");

			const content = readFileSync(path, "utf-8");
			const occurrences = content.split(old_text).length - 1;

			if (occurrences === 0) {
				throw new Error(`Text not found in ${path}`);
			}
			if (occurrences > 1) {
				throw new Error(`Text found ${occurrences} times in ${path} — must be unique`);
			}

			const newContent = content.replace(old_text, new_text);
			writeFileSync(path, newContent);

			const diff = generateDiffString(content, newContent);
			return {
				content: [{ type: "text" as const, text: `Edited ${path}\n\n${diff}` }],
				details: undefined,
			};
		},
	};
}
