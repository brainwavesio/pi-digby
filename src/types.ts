export interface BotEvent {
	type: "mention" | "dm" | "channel" | "agent_session";
	source: "slack" | "linear";
	channel: string;
	ts: string;
	user: string;
	text: string;
	files?: Array<{ name?: string; url_private_download?: string; url_private?: string }>;
	attachments?: Attachment[];
	threadTs?: string;
}

export interface Attachment {
	name: string;
	local: string;
}
