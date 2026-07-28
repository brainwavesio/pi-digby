export type { Attachment, BotEvent as WhatsAppEvent } from "../types.js";

export interface WhatsAppUser {
	jid: string;
	name?: string;
}
