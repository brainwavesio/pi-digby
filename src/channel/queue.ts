type QueuedWork = () => Promise<void>;

export class ChannelQueue {
	private queue: QueuedWork[] = [];
	private processing = false;

	enqueue(work: QueuedWork): void {
		this.queue.push(work);
		this.processNext();
	}

	size(): number {
		return this.queue.length;
	}

	isProcessing(): boolean {
		return this.processing;
	}

	isBusy(): boolean {
		return this.processing || this.queue.length > 0;
	}

	private async processNext(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;
		const work = this.queue.shift()!;
		try {
			await work();
		} catch (err) {
			// Log but don't crash the queue
			console.warn("[queue] Error:", err instanceof Error ? err.message : String(err));
		}
		this.processing = false;
		this.processNext();
	}
}
