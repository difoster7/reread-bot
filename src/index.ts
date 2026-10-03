import { PLANS } from "../plans/index.ts";
import { handleRequest } from "./admin.ts";
import { parseConfig, type Env } from "./config.ts";
import { DiscordClient } from "./discord.ts";
import { runScheduled } from "./run.ts";

export default {
    async scheduled(controller, env) {
        const cfg = parseConfig(env, PLANS);
        await runScheduled(
            cfg,
            env.STATE,
            new DiscordClient(cfg.token ?? ""),
            controller.scheduledTime,
        );
    },

    fetch(request, env) {
        return handleRequest(request, env, PLANS, Date.now());
    },
} satisfies ExportedHandler<Env>;
