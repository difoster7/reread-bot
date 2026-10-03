import { ConfigError, parseConfig, type Config, type Env } from "./config.ts";
import {
    DiscordClient,
    DiscordHttpError,
    DiscordNetworkError,
    type DiscordApi,
} from "./discord.ts";
import { isDue, localNow, pickThreadSession, postDate } from "./due.ts";
import type { Plan, Session } from "./plan.ts";
import { renderPost, renderReminder } from "./render.ts";
import { createSessionThread } from "./run.ts";

const json = (body: unknown, status = 200): Response => Response.json(body, { status });
const notFound = (): Response => new Response("Not found", { status: 404 });

/** Constant-time comparison via fixed-length digests. */
async function secretMatches(given: string, expected: string): Promise<boolean> {
    const encoder = new TextEncoder();
    const [a, b] = await Promise.all(
        [given, expected].map((s) => crypto.subtle.digest("SHA-256", encoder.encode(s))),
    );
    const x = new Uint8Array(a);
    const y = new Uint8Array(b);
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
    return diff === 0;
}

/** Admin HTTP API. Every path is 404 unless the ADMIN_SECRET secret is set. */
export async function handleRequest(
    request: Request,
    env: Env,
    plans: Record<string, Plan>,
    instant: number,
    discord?: DiscordApi,
): Promise<Response> {
    const secret = typeof env.ADMIN_SECRET === "string" ? env.ADMIN_SECRET : "";
    const url = new URL(request.url);
    if (secret === "" || !url.pathname.startsWith("/admin/")) return notFound();
    if (!(await secretMatches(request.headers.get("X-Admin-Secret") ?? "", secret))) {
        return json({ error: "unauthorized" }, 401);
    }

    let cfg: Config;
    try {
        cfg = parseConfig(env, plans);
    } catch (err) {
        if (err instanceof ConfigError) {
            return json({ error: "invalid configuration", problems: err.problems }, 500);
        }
        throw err;
    }

    if (request.method === "GET" && url.pathname === "/admin/preview") {
        return preview(cfg, env.STATE, url, instant);
    }
    if (request.method === "POST" && url.pathname === "/admin/force-post") {
        return forcePost(cfg, discord ?? new DiscordClient(cfg.token ?? ""), url);
    }
    return notFound();
}

/** The latest due session if unposted, else the next session not yet due. */
async function defaultSession(
    cfg: Config,
    kv: KVNamespace,
    instant: number,
): Promise<Session | undefined> {
    const now = localNow(instant, cfg.timezone);
    const due = pickThreadSession(cfg.sessions, now, cfg);
    if (due && (await kv.get(`session:${due.n}`)) === null) return due;
    return cfg.sessions.find(
        (s) => !isDue(postDate(s, cfg.postOffsetDays), now, cfg.postHour),
    );
}

async function preview(
    cfg: Config,
    kv: KVNamespace,
    url: URL,
    instant: number,
): Promise<Response> {
    const raw = url.searchParams.get("session");
    const session =
        raw === null
            ? await defaultSession(cfg, kv, instant)
            : cfg.sessions.find((s) => String(s.n) === raw);
    if (!session) {
        return json({ error: raw === null ? "no upcoming session" : `unknown session "${raw}"` }, 400);
    }
    const post = renderPost(cfg, cfg.sessions, session);
    const next = cfg.sessions.find((s) => s.n === session.n + 1);
    return json({
        session,
        postDate: postDate(session, cfg.postOffsetDays),
        title: post.title,
        content: post.content,
        reminder:
            next && cfg.reminderDaysBefore > 0 ? renderReminder(cfg.templates, next) : null,
        record: await kv.get(`session:${session.n}`, "json"),
    });
}

/** Posts a session to the test channel: no KV, no lock, no tags, no ping. */
async function forcePost(cfg: Config, discord: DiscordApi, url: URL): Promise<Response> {
    if (!cfg.testChannelId) return json({ error: "TEST_CHANNEL_ID is not set" }, 400);
    const raw = url.searchParams.get("session");
    const session = cfg.sessions.find((s) => String(s.n) === raw);
    if (!session) return json({ error: `unknown session "${raw}"` }, 400);

    const post = renderPost(
        { templates: cfg.templates, spoilerPolicy: cfg.spoilerPolicy },
        cfg.sessions,
        session,
    );
    if (cfg.dryRun) return json({ dryRun: true, channelId: cfg.testChannelId, ...post });
    try {
        const threadId = await createSessionThread(
            discord,
            cfg.testChannelId,
            cfg.testChannelMode,
            post,
            [],
        );
        if (cfg.testChannelMode === "text") await discord.sendMessage(threadId, post.content);
        return json({ posted: true, channelId: cfg.testChannelId, threadId, ...post });
    } catch (err) {
        if (err instanceof DiscordHttpError || err instanceof DiscordNetworkError) {
            return json({ error: err.message }, 502);
        }
        throw err;
    }
}
