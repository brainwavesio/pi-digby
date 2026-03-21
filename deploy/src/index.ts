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
		DD_API_KEY: (env.DD_API_KEY as string) ?? "",
		DD_APP_KEY: (env.DD_APP_KEY as string) ?? "",
		R2_ACCOUNT_ID: (env.R2_ACCOUNT_ID as string) ?? "",
		R2_BUCKET_NAME: (env.R2_BUCKET_NAME as string) ?? "",
		R2_ACCESS_KEY_ID: (env.R2_ACCESS_KEY_ID as string) ?? "",
		R2_SECRET_ACCESS_KEY: (env.R2_SECRET_ACCESS_KEY as string) ?? "",
	};

	override async onStart() {
		console.log("pi-digby started");
		const count = ((await this.ctx.storage.get<number>("restartCount")) ?? 0) + 1;
		await this.ctx.storage.put("restartCount", count);
		await this.ctx.storage.put("startedAt", Date.now());
		await this.ctx.storage.delete("lastError");
		await this.ctx.storage.delete("lastErrorAt");
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

	override async onStop(params: { exitCode: number; reason: string }) {
		console.log("pi-digby stopped:", params);
		await this.ctx.storage.put("lastStopAt", Date.now());
		await this.ctx.storage.put("lastStopExitCode", params.exitCode);
		await this.ctx.storage.put("lastStopReason", params.reason);
	}

	override async onError(error: unknown) {
		console.error("pi-digby error:", error);
		await this.ctx.storage.put("lastError", String(error));
		await this.ctx.storage.put("lastErrorAt", Date.now());
	}

	async checkHealth(deploySha: string) {
		const storedSha = await this.ctx.storage.get<string>("deploySha");

		// New deploy detected — force clean restart after rollout settles
		if (deploySha && storedSha !== deploySha) {
			console.log(`New deploy detected: ${storedSha ?? "none"} → ${deploySha}, restarting...`);
			await this.destroy();
			await this.start();
			await this.ctx.storage.put("deploySha", deploySha);
			return;
		}

		// Container claims to be running but errored after start (Cloudflare ghost state)
		const startedAt = await this.ctx.storage.get<number>("startedAt");
		const lastErrorAt = await this.ctx.storage.get<number>("lastErrorAt");
		const state = await this.getState();
		if (startedAt && lastErrorAt && lastErrorAt > startedAt) {
			console.log(`Container errored after start (${new Date(lastErrorAt).toISOString()}), restarting...`);
			await this.destroy();
			await this.start();
			return;
		}

		// Standard check: restart if not running
		if (state.status !== "running" && state.status !== "healthy") {
			console.log(`Bot not running (${state.status}), restarting...`);
			await this.start();
		}
	}

	async getDiagnostics() {
		const startedAt = await this.ctx.storage.get<number>("startedAt");
		const lastErrorAt = await this.ctx.storage.get<number>("lastErrorAt");
		const lastStopAt = await this.ctx.storage.get<number>("lastStopAt");
		return {
			startedAt: startedAt ? new Date(startedAt).toISOString() : null,
			uptime: startedAt ? Math.round((Date.now() - startedAt) / 1000) : null,
			restartCount: (await this.ctx.storage.get<number>("restartCount")) ?? 0,
			lastError: (await this.ctx.storage.get<string>("lastError")) ?? null,
			lastErrorAt: lastErrorAt ? new Date(lastErrorAt).toISOString() : null,
			lastStopAt: lastStopAt ? new Date(lastStopAt).toISOString() : null,
			lastStopExitCode: (await this.ctx.storage.get<number>("lastStopExitCode")) ?? null,
			lastStopReason: (await this.ctx.storage.get<string>("lastStopReason")) ?? null,
		};
	}
}

interface Env {
	PI_MOM: DurableObjectNamespace;
	DEPLOY_SHA?: string;
}

export default {
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url);
		const bot = getContainer(env.PI_MOM, "singleton");

		// Health check on every request: detects new deploys + ghost containers
		if (url.pathname !== "/stop") {
			await bot.checkHealth(env.DEPLOY_SHA ?? "");
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
				const diag = await bot.getDiagnostics();
				return Response.json({ ...state, deploySha: env.DEPLOY_SHA ?? "", ...diag });
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
		await bot.checkHealth(env.DEPLOY_SHA ?? "");
	},
} satisfies ExportedHandler<Env>;
