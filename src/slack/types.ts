export interface SlackUser {
	id: string;
	userName: string;
	displayName: string;
}

export interface SlackChannel {
	id: string;
	name: string;
}

export interface SlackEvent {
	type: "mention" | "dm" | "channel";
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
