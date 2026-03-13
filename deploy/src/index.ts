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
		BROWSER_USE_API_KEY: (env.BROWSER_USE_API_KEY as string) ?? "",
		EXA_API_KEY: (env.EXA_API_KEY as string) ?? "",
		GH_TOKEN: (env.GH_TOKEN as string) ?? "",
	};

	override async onStart() {
		console.log("pi-digby started");
		// Schedule a recurring alarm to keep the Durable Object awake.
		// Without this, the DO hibernates when idle and kills the container.
		await this.schedule(5 * 60, "keepAlive");
	}

	async keepAlive() {
		await this.renewActivityTimeout();
		await this.schedule(5 * 60, "keepAlive");
	}

	override async onActivityExpired() {
		await this.renewActivityTimeout();
	}

	override onStop() {
		console.log("pi-digby stopped");
	}

	override onError(error: unknown) {
		console.error("pi-digby error:", error);
	}
}

interface Env {
	PI_MOM: DurableObjectNamespace;
}

export default {
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url);
		const bot = getContainer(env.PI_MOM, "singleton");

		// Ensure the bot is running on every request (covers fresh deploys)
		const state = await bot.getState();
		if (state.status !== "running" && state.status !== "healthy" && url.pathname !== "/stop") {
			await bot.start();
		}

		switch (url.pathname) {
			case "/start":
				return new Response(null, { status: 302, headers: { Location: "/status" } });
			case "/stop":
				await bot.stop();
				return new Response(null, { status: 302, headers: { Location: "/status" } });
			case "/restart":
				await bot.destroy();
				await bot.start();
				return new Response(null, { status: 302, headers: { Location: "/status" } });
			case "/status": {
				const state = await bot.getState();
				return Response.json(state);
			}
			default:
				return new Response(
					`<!doctype html><html><body>
<h2>pi-digby</h2>
<ul>
<li><a href="/start">/start</a></li>
<li><a href="/stop">/stop</a></li>
<li><a href="/restart">/restart</a></li>
<li><a href="/status">/status</a></li>
</ul>
</body></html>`,
					{ headers: { "content-type": "text/html" } },
				);
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
