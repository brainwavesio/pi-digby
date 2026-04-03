import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const MAX_LINES = 500;
const MAX_BYTES = 100 * 1024;

export function createBashTool(): AgentTool<any> {
	const schema = Type.Object({
		label: Type.String({ description: "Brief description (shown to user)" }),
		command: Type.String({ description: "The bash command to execute" }),
		timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
	});

	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command. Output truncated to last ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB. Optionally provide timeout in seconds.`,
		parameters: schema,
		execute: async (_toolCallId, { command, timeout }, signal, _onUpdate?) => {
			const result = await execCommand(command, { timeout, signal });
			return { content: [{ type: "text" as const, text: result }], details: undefined };
		},
	};
}

function execCommand(command: string, options?: { timeout?: number; signal?: AbortSignal }): Promise<string> {
	return new Promise((resolve, reject) => {
		if (options?.signal?.aborted) {
			reject(new Error("Aborted"));
			return;
		}

		const proc = spawn("bash", ["-c", command], {
			cwd: process.env.HOME || "/",
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		let killed = false;
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		if (options?.timeout && options.timeout > 0) {
			timeoutHandle = setTimeout(() => {
				killed = true;
				proc.kill("SIGKILL");
			}, options.timeout * 1000);
		}

		const abortHandler = () => {
			proc.kill("SIGKILL");
		};
		options?.signal?.addEventListener("abort", abortHandler, { once: true });

		proc.on("close", (code) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			options?.signal?.removeEventListener("abort", abortHandler);

			const fullOutput = stdout + stderr;
			let output = fullOutput;
			let truncatedPath: string | undefined;

			const lines = output.split("\n");
			if (lines.length > MAX_LINES || output.length > MAX_BYTES) {
				// Save full output to temp file
				const tmpFile = join(tmpdir(), `bash-output-${Date.now()}.txt`);
				try {
					writeFileSync(tmpFile, fullOutput);
					truncatedPath = tmpFile;
				} catch {
					// Ignore write errors for temp file
				}

				const truncatedLines = lines.slice(-MAX_LINES);
				output = truncatedLines.join("\n");
				if (output.length > MAX_BYTES) {
					output = output.slice(-MAX_BYTES);
				}
				output = `[output truncated — showing last ${MAX_LINES} lines${truncatedPath ? `, full output saved to ${truncatedPath}` : ""}]\n${output}`;
			}

			if (options?.signal?.aborted) {
				reject(new Error("Aborted"));
				return;
			}

			if (killed) {
				output += `\n[killed: timeout after ${options?.timeout}s]`;
			} else if (code !== 0 && code !== null) {
				output += `\n[exit code: ${code}]`;
			}

			resolve(output);
		});

		proc.on("error", (err) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			options?.signal?.removeEventListener("abort", abortHandler);
			reject(err);
		});
	});
}
