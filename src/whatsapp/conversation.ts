import type { LogContextScope } from "../persistence/log.js";
import { channelIdToJid } from "./client.js";
import type { WhatsAppEvent } from "./types.js";

export interface WhatsAppConversationTarget {
	runnerId: string;
	sessionDir: string;
	jid: string;
	logContextScope: LogContextScope;
}

export function getWhatsAppConversationTarget(
	event: WhatsAppEvent,
	channelDir: string,
): WhatsAppConversationTarget {
	const jid = channelIdToJid(event.channel);

	return {
		runnerId: event.channel,
		sessionDir: channelDir,
		jid,
		logContextScope: { source: "whatsapp", kind: "chronological" },
	};
}
