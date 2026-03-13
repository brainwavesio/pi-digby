import { Container, getContainer } from "@cloudflare/containers";
import { env } from "cloudflare:workers";

export class PiMomContainer extends Container {
	sleepAfter = "15m";
	enableInternet = true;

	envVars = {
		MOM_SLACK_APP_TOKEN: env.MOM_SLACK_APP_TOKEN as string,
		MOM_SLACK_BOT_TOKEN: env.MOM_SLACK_BOT_TOKEN as string,
		AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID as string,
		AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY as string,
		AWS_REGION: (env.AWS_REGION as string) ?? "us-east-1",
		AWS_PROFILE: "default",
	};

	override async onActivityExpired() {
		// Keep the container alive instead of letting it sleep
		await this.renewActivityTimeout();
	}

	override onStart() {
		console.log("pi-mom started");
	}

	override onStop() {
		console.log("pi-mom stopped");
	}

	override onError(error: unknown) {
		console.error("pi-mom error:", error);
	}
}

interface Env {
	PI_MOM: DurableObjectNamespace;
}

export default {
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url);
		const bot = getContainer(env.PI_MOM, "singleton");

		switch (url.pathname) {
			case "/start":
				await bot.start();
				return new Response("Started");
			case "/stop":
				await bot.stop();
				return new Response("Stopped");
			case "/restart":
				await bot.destroy();
				await bot.start();
				return new Response("Restarted");
			case "/status": {
				const state = await bot.getState();
				return Response.json(state);
			}
			default:
				return new Response("pi-digby\n\nGET /start /stop /restart /status");
		}
	},

	async scheduled(_event: ScheduledEvent, env: Env) {
		const bot = getContainer(env.PI_MOM, "singleton");
		const state = await bot.getState();
		if (state.status !== "running" && state.status !== "healthy") {
			console.log(`Bot not running (${state.status}), restarting...`);
			await bot.start();
		}
	},
} satisfies ExportedHandler<Env>;
