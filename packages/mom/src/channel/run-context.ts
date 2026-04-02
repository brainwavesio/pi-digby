import * as log from "../log.js";

const MAX_MESSAGE_LENGTH = 35000;
const MAX_THREAD_MESSAGE_LENGTH = 20000;

interface SlackClientLike {
	postMessage(channel: string, text: string, threadTs?: string): Promise<string>;
	updateMessage(channel: string, ts: string, text: string): Promise<void>;
	deleteMessage(channel: string, ts: string): Promise<void>;
	addReaction(channel: string, ts: string, emoji: string): Promise<void>;
	uploadFile(channel: string, filePath: string, title?: string): Promise<void>;
}

export class RunContext {
	private client: SlackClientLike;
	private channel: string;
	private replyThreadTs?: string;

	messageTs: string | null = null;
	resolved = false;
	accumulatedText = "";
	isWorking = false;
	threadMessageTs: string[] = [];

	private updateChain: Promise<void> = Promise.resolve();

	constructor(client: SlackClientLike, channel: string, replyThreadTs?: string) {
		this.client = client;
		this.channel = channel;
		this.replyThreadTs = replyThreadTs;
	}

	/** Enqueue a Slack operation onto the serial update chain */
	private enqueueUpdate(fn: () => Promise<void>): void {
		this.updateChain = this.updateChain.then(fn).catch((err) => {
			log.warn(`[run-context] Slack update error: ${err instanceof Error ? err.message : String(err)}`);
		});
	}

	/** Build the display text with optional working indicator */
	private get displayText(): string {
		const text = this.accumulatedText;
		if (this.isWorking) {
			return text ? text + "\n..." : "...";
		}
		return text;
	}

	/** Truncate text to the given limit */
	private truncate(text: string, limit: number): string {
		if (text.length <= limit) return text;
		return text.slice(0, limit) + "\n...(truncated)";
	}

	/** Append text to the accumulated message and post/update in Slack */
	respond(text: string, _shouldLog?: boolean): void {
		this.accumulatedText = this.accumulatedText ? `${this.accumulatedText}\n${text}` : text;
		this.enqueueUpdate(async () => {
			const display = this.truncate(this.displayText, MAX_MESSAGE_LENGTH);
			if (!display) return;
			try {
				if (this.messageTs) {
					await this.client.updateMessage(this.channel, this.messageTs, display);
				} else {
					this.messageTs = await this.client.postMessage(this.channel, display, this.replyThreadTs);
				}
			} catch (err) {
				log.warn(`[run-context] respond error: ${err instanceof Error ? err.message : String(err)}`);
			}
		});
	}

	/** Replace the accumulated text entirely and update in Slack */
	replaceMessage(text: string): void {
		this.accumulatedText = text;
		this.enqueueUpdate(async () => {
			const display = this.truncate(this.displayText, MAX_MESSAGE_LENGTH);
			if (!display) return;
			try {
				if (this.messageTs) {
					await this.client.updateMessage(this.channel, this.messageTs, display);
				} else {
					this.messageTs = await this.client.postMessage(this.channel, display, this.replyThreadTs);
				}
			} catch (err) {
				log.warn(`[run-context] replaceMessage error: ${err instanceof Error ? err.message : String(err)}`);
			}
		});
	}

	/** Post a reply in the thread under the bot's main message */
	respondInThread(text: string): void {
		this.enqueueUpdate(async () => {
			if (!this.messageTs) return;
			try {
				const truncated = this.truncate(text, MAX_THREAD_MESSAGE_LENGTH);
				const ts = await this.client.postMessage(this.channel, truncated, this.messageTs);
				this.threadMessageTs.push(ts);
			} catch (err) {
				log.warn(`[run-context] respondInThread error: ${err instanceof Error ? err.message : String(err)}`);
			}
		});
	}

	/** Post the initial "thinking" message */
	setTyping(isTyping: boolean): void {
		if (!isTyping) return;
		this.isWorking = true;
		this.enqueueUpdate(async () => {
			try {
				if (!this.messageTs) {
					this.messageTs = await this.client.postMessage(this.channel, "...", this.replyThreadTs);
				}
			} catch (err) {
				log.warn(`[run-context] setTyping error: ${err instanceof Error ? err.message : String(err)}`);
			}
		});
	}

	/** Toggle the "..." working indicator on the message */
	setWorking(working: boolean): void {
		this.isWorking = working;
		this.enqueueUpdate(async () => {
			if (!this.messageTs) return;
			try {
				const display = this.truncate(this.displayText, MAX_MESSAGE_LENGTH);
				if (display) {
					await this.client.updateMessage(this.channel, this.messageTs, display);
				}
			} catch (err) {
				log.warn(`[run-context] setWorking error: ${err instanceof Error ? err.message : String(err)}`);
			}
		});
	}

	/** Delete the main message and all thread messages */
	deleteMessage(): void {
		this.enqueueUpdate(async () => {
			try {
				// Delete thread messages first
				for (const ts of this.threadMessageTs) {
					await this.client.deleteMessage(this.channel, ts);
				}
				this.threadMessageTs = [];
				// Delete main message
				if (this.messageTs) {
					await this.client.deleteMessage(this.channel, this.messageTs);
					this.messageTs = null;
				}
			} catch (err) {
				log.warn(`[run-context] deleteMessage error: ${err instanceof Error ? err.message : String(err)}`);
			}
		});
	}

	/** Add a reaction to a specific message */
	addReaction(emoji: string, triggerTs: string): void {
		this.enqueueUpdate(async () => {
			try {
				await this.client.addReaction(this.channel, triggerTs, emoji);
			} catch (err) {
				log.warn(`[run-context] addReaction error: ${err instanceof Error ? err.message : String(err)}`);
			}
		});
	}

	/** Upload a file to the channel */
	uploadFile(filePath: string, title?: string): void {
		this.enqueueUpdate(async () => {
			try {
				await this.client.uploadFile(this.channel, filePath, title);
			} catch (err) {
				log.warn(`[run-context] uploadFile error: ${err instanceof Error ? err.message : String(err)}`);
			}
		});
	}

	/** Wait for all queued updates to complete */
	async flush(): Promise<void> {
		await this.updateChain;
	}

	/** Mark the run as resolved and remove the working indicator */
	resolve(): void {
		if (this.resolved) return;
		this.resolved = true;
		this.isWorking = false;
		this.enqueueUpdate(async () => {
			if (!this.messageTs) return;
			try {
				const display = this.truncate(this.accumulatedText, MAX_MESSAGE_LENGTH);
				if (display) {
					await this.client.updateMessage(this.channel, this.messageTs, display);
				}
			} catch (err) {
				log.warn(`[run-context] resolve error: ${err instanceof Error ? err.message : String(err)}`);
			}
		});
	}

	/** Mark the run as resolved with an error, post the error and remove working indicator */
	reject(error: string): void {
		if (this.resolved) return;
		this.resolved = true;
		this.isWorking = false;
		const errorText = this.accumulatedText
			? this.accumulatedText + `\n\n:warning: ${error}`
			: `:warning: ${error}`;
		this.accumulatedText = errorText;
		this.enqueueUpdate(async () => {
			try {
				const display = this.truncate(errorText, MAX_MESSAGE_LENGTH);
				if (this.messageTs) {
					await this.client.updateMessage(this.channel, this.messageTs, display);
				} else {
					this.messageTs = await this.client.postMessage(this.channel, display, this.replyThreadTs);
				}
			} catch (err) {
				log.warn(`[run-context] reject error: ${err instanceof Error ? err.message : String(err)}`);
			}
		});
	}

	/** Safety net: if not resolved, reject with a default message. Always call in finally block. */
	dispose(): void {
		if (!this.resolved) {
			this.reject("Run ended unexpectedly");
		}
	}
}
