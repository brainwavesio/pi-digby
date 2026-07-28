import { join } from "path";
import type { LogContextScope } from "../persistence/log.js";
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
	const jid = event.channel.replace(/^whatsapp:/, "").replace(/-/g, ".");
	const isGroup = jid.endsWith("@g.us");
	const correctedJid = isGroup
		? jid.replace(/\.g\.us$/, "@g.us")
		: jid.replace(/\.s\.whatsapp\.net$/, "@s.whatsapp.net");

	return {
		runnerId: event.channel,
		sessionDir: channelDir,
		jid: correctedJid,
		logContextScope: { source: "whatsapp", kind: "chronological" },
	};
}
