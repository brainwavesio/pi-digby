import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelState } from "../src/channel/state.js";

describe("ChannelState", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	it("keeps log writes append-only and reconstructs timestamp sets from disk", () => {
		tempDir = mkdtempSync(join(tmpdir(), "digby-channel-state-"));
		const state = new ChannelState("C123", tempDir);

		state.logUserMessage({
			type: "channel",
			source: "slack",
			channel: "C123",
			ts: "100.000000",
			user: "U1",
			text: "channel message",
		});
		state.logUserMessage({
			type: "channel",
			source: "slack",
			channel: "C123",
			ts: "101.000000",
			threadTs: "100.000000",
			user: "U2",
			text: "thread reply",
		});
		state.logBotResponse("bot reply", "102.000000", "100.000000");

		const lines = readFileSync(join(state.channelDir, "log.jsonl"), "utf-8").trim().split("\n");
		expect(lines).toHaveLength(3);
		expect(lines.map((line) => JSON.parse(line).ts)).toEqual(["100.000000", "101.000000", "102.000000"]);
		expect(state.getLogTimestamps()).toEqual(new Set(["100.000000", "101.000000", "102.000000"]));
		expect(state.getLogTimestampsForThread("100.000000")).toEqual(
			new Set(["100.000000", "101.000000", "102.000000"]),
		);
	});
});
