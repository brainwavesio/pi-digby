import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { readFileSync } from "fs";
import { formatDimensionNote, resizeImage } from "../utils/image-resize.js";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.js";

export function createReadTool(): AgentTool<any> {
	const schema = Type.Object({
		label: Type.String({ description: "Brief description (shown to user)" }),
		path: Type.String({ description: "Absolute path to the file" }),
		offset: Type.Optional(Type.Number({ description: "Line offset (1-indexed)" })),
		limit: Type.Optional(Type.Number({ description: "Maximum lines to read" })),
	});

	return {
		name: "read",
		label: "read",
		description: `Read file contents or view images (jpg, png, gif, webp). Text output truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. Use offset/limit for large files.`,
		parameters: schema,
		execute: async (_toolCallId, { path, offset, limit }, signal, _onUpdate?) => {
			if (signal?.aborted) throw new Error("Aborted");

			// Check for image
			let mimeType: string | null = null;
			try {
				mimeType = await detectSupportedImageMimeTypeFromFile(path);
			} catch {
				// Not an image or can't read — fall through to text
			}

			if (mimeType) {
				const buffer = readFileSync(path);
				const base64 = buffer.toString("base64");
				const resized = await resizeImage({ type: "image", data: base64, mimeType });

				if (!resized) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Read image file [${mimeType}]\n[Image omitted: could not be resized below the inline image size limit.]`,
							},
						],
						details: undefined,
					};
				}

				const dimensionNote = formatDimensionNote(resized);
				let textNote = `Read image file [${resized.mimeType}]`;
				if (dimensionNote) textNote += `\n${dimensionNote}`;

				return {
					content: [
						{ type: "text" as const, text: textNote },
						{ type: "image", data: resized.data, mimeType: resized.mimeType } as ImageContent,
					],
					details: undefined,
				};
			}

			// Text file
			const content = readFileSync(path, "utf-8");
			const allLines = content.split("\n");
			const totalFileLines = allLines.length;

			// Apply offset (1-indexed input → 0-indexed array)
			const startLine = offset ? Math.max(0, offset - 1) : 0;
			const startLineDisplay = startLine + 1;

			if (startLine >= allLines.length) {
				throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
			}

			let selectedContent: string;
			let userLimitedLines: number | undefined;

			if (limit !== undefined) {
				const endLine = Math.min(startLine + limit, allLines.length);
				selectedContent = allLines.slice(startLine, endLine).join("\n");
				userLimitedLines = endLine - startLine;
			} else {
				selectedContent = allLines.slice(startLine).join("\n");
			}

			// Apply truncation
			const truncation = truncateHead(selectedContent);
			let outputText: string;

			if (truncation.firstLineExceedsLimit) {
				const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
				outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
			} else if (truncation.truncated) {
				const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
				const nextOffset = endLineDisplay + 1;
				outputText = truncation.content;
				if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
				} else {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
				}
			} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
				const remaining = allLines.length - (startLine + userLimitedLines);
				const nextOffset = startLine + userLimitedLines + 1;
				outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
			} else {
				outputText = truncation.content;
			}

			return { content: [{ type: "text" as const, text: outputText }], details: undefined };
		},
	};
}
