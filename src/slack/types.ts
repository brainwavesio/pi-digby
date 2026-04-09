export type { Attachment, BotEvent as SlackEvent } from "../types.js";

export interface SlackUser {
	id: string;
	userName: string;
	displayName: string;
}

export interface SlackChannel {
	id: string;
	name: string;
}
