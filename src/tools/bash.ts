import type { AgentTool } from "@mariozechner/pi-agent-core";
import { spawn } from "child_process";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Type } from "typebox";
import { formatSize, truncateTail } from "./truncate.js";

const bashSchema = Type.Object({
	label: Type.String({ description: "Brief description (shown to user)" }),
	command: Type.String({ description: "The bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
});

export function createBashTool(): AgentTool<typeof bashSchema> {
	return {
		name: "bash",
		label: "bash",
		description:
			"Execute a bash command. Output truncated to last 2000 lines or 50KB. Optionally provide timeout in seconds.",
		parameters: bashSchema,
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

		// setsid creates a new session/process group so we can kill the entire
		// tree (including child processes) with a single signal via -pid.
		const proc = spawn("setsid", ["bash", "-c", command], {
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

		const killProcessGroup = () => {
			try {
				if (proc.pid) process.kill(-proc.pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		};

		let killed = false;
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		if (options?.timeout && options.timeout > 0) {
			timeoutHandle = setTimeout(() => {
				killed = true;
				killProcessGroup();
			}, options.timeout * 1000);
		}

		const abortHandler = () => {
			killProcessGroup();
		};
		options?.signal?.addEventListener("abort", abortHandler, { once: true });

		proc.on("close", (code) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			options?.signal?.removeEventListener("abort", abortHandler);

			const fullOutput = stdout + stderr;
			const truncation = truncateTail(fullOutput);
			let output = truncation.content;

			if (truncation.truncated) {
				// Save full output to temp file
				let truncatedPath: string | undefined;
				const tmpFile = join(tmpdir(), `bash-output-${Date.now()}.txt`);
				try {
					writeFileSync(tmpFile, fullOutput);
					truncatedPath = tmpFile;
				} catch {
					// Ignore write errors for temp file
				}

				const notice = truncatedPath
					? `[output truncated — showing last ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.totalBytes)} total), full output saved to ${truncatedPath}]`
					: `[output truncated — showing last ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.totalBytes)} total)]`;
				output = `${notice}\n${output}`;
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
