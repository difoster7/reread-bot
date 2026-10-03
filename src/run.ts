import type { ChannelMode, Config } from "./config.ts";
import { DiscordHttpError, type DiscordApi } from "./discord.ts";
import {
    localNow,
    pickReminder,
    pickThreadSession,
    skippedSessions,
    type LocalNow,
} from "./due.ts";
import type { Session } from "./plan.ts";
import { renderPost, renderReminder, type RenderedPost } from "./render.ts";

export interface SessionRecord {
    status: "pending" | "posted";
    threadId?: string;
    startedAt: string;
    postedAt?: string;
}

export interface LatestRecord {
    n: number;
    threadId: string;
}

type Step = (cfg: Config, kv: KVNamespace, discord: DiscordApi, now: LocalNow) => Promise<void>;

/** One hourly run: open the due session's thread, then post any due reminder. */
export async function runScheduled(
    cfg: Config,
    kv: KVNamespace,
    discord: DiscordApi,
    instant: number,
): Promise<void> {
    const now = localNow(instant, cfg.timezone);
    const steps: [string, Step][] = [
        ["thread", threadStep],
        ["reminder", reminderStep],
    ];
    const failures: unknown[] = [];
    for (const [name, step] of steps) {
        try {
            await step(cfg, kv, discord, now);
        } catch (err) {
            logError(`${name} step failed`, err);
            failures.push(err);
        }
    }
    if (failures.length > 0) {
        throw new AggregateError(
            failures,
            `Scheduled run failed: ${failures.map(String).join("; ")}`,
        );
    }
}

/** Creates the thread (forum: with its opening message). Returns the thread ID. */
export function createSessionThread(
    discord: DiscordApi,
    channelId: string,
    mode: ChannelMode,
    post: RenderedPost,
    tagIds: string[],
    roleId?: string,
): Promise<string> {
    return mode === "forum"
        ? discord.createForumPost(channelId, {
              name: post.title,
              content: post.content,
              tagIds,
              roleId,
          })
        : discord.createThread(channelId, post.title);
}

async function threadStep(
    cfg: Config,
    kv: KVNamespace,
    discord: DiscordApi,
    now: LocalNow,
): Promise<void> {
    const target = pickThreadSession(cfg.sessions, now, cfg);
    if (!target) return;
    const key = `session:${target.n}`;
    const existing = await kv.get<SessionRecord>(key, "json");
    if (existing?.status === "posted") return;
    if (existing?.status === "pending") {
        throw new Error(
            `Session ${target.n} is stuck pending since ${existing.startedAt}; ` +
                `check Discord, then fix KV key "${key}" (see README)`,
        );
    }

    const latest = await kv.get<LatestRecord>("latest", "json");
    for (const s of skippedSessions(cfg.sessions, latest?.n ?? 0, target)) {
        console.warn(`Session ${s.n} (${s.date}) was missed and will not be backfilled`);
    }
    const post = renderPost(cfg, cfg.sessions, target);
    if (cfg.dryRun) {
        console.log(
            `[dry-run] would open session ${target.n} in ${cfg.channelMode} channel ${cfg.channelId}`,
            post,
        );
        if (cfg.lockPrevious && latest) {
            console.log(`[dry-run] would lock thread ${latest.threadId}`);
        }
        return;
    }

    const threadId = await postSession(cfg, kv, discord, target, post);
    await kv.put("latest", JSON.stringify({ n: target.n, threadId } satisfies LatestRecord));
    console.log(
        `Opened session ${target.n}: https://discord.com/channels/${cfg.guildId}/${threadId}`,
    );
    if (cfg.lockPrevious && latest) {
        try {
            await discord.archiveThread(latest.threadId, true);
        } catch (err) {
            logError(`Could not lock session ${latest.n} thread ${latest.threadId}`, err);
        }
    }
}

/**
 * Posts a session guarded by a pending marker. HTTP errors mean nothing was
 * created, so the marker is released for a retry next hour. Ambiguous
 * failures leave it pending: a missed post beats a duplicate.
 */
async function postSession(
    cfg: Config,
    kv: KVNamespace,
    discord: DiscordApi,
    session: Session,
    post: RenderedPost,
): Promise<string> {
    const key = `session:${session.n}`;
    const startedAt = new Date().toISOString();
    const save = (record: SessionRecord) => kv.put(key, JSON.stringify(record));
    await save({ status: "pending", startedAt });

    const tag = cfg.forumTags[session.book.short];
    let threadId: string;
    try {
        threadId = await createSessionThread(
            discord,
            cfg.channelId,
            cfg.channelMode,
            post,
            tag ? [tag] : [],
            cfg.roleId,
        );
    } catch (err) {
        if (err instanceof DiscordHttpError) await kv.delete(key);
        throw err;
    }

    if (cfg.channelMode === "text") {
        try {
            await discord.sendMessage(threadId, post.content, cfg.roleId);
        } catch (err) {
            if (!(err instanceof DiscordHttpError)) {
                console.error(
                    `Session ${session.n}: thread ${threadId} created but opening message outcome unknown; ${key} left pending`,
                );
                throw err;
            }
            try {
                await discord.deleteChannel(threadId);
            } catch (deleteErr) {
                logError(
                    `Session ${session.n}: could not delete empty thread ${threadId}; recording it as posted`,
                    deleteErr,
                );
                await save({ status: "posted", threadId, startedAt, postedAt: new Date().toISOString() });
                throw err;
            }
            await kv.delete(key);
            throw err;
        }
    }

    await save({ status: "posted", threadId, startedAt, postedAt: new Date().toISOString() });
    return threadId;
}

async function reminderStep(
    cfg: Config,
    kv: KVNamespace,
    discord: DiscordApi,
    now: LocalNow,
): Promise<void> {
    const next = pickReminder(cfg.sessions, now, cfg);
    if (!next) return;
    const key = `reminder:${next.n}`;
    if ((await kv.get(key)) !== null) return;
    const latest = await kv.get<LatestRecord>("latest", "json");
    if (!latest) return;

    const content = renderReminder(cfg.templates, next);
    if (cfg.dryRun) {
        console.log(`[dry-run] would remind in thread ${latest.threadId}`, content);
        return;
    }
    const messageId = await discord.sendMessage(latest.threadId, content);
    await kv.put(key, JSON.stringify({ messageId, postedAt: new Date().toISOString() }));
}

function logError(message: string, err: unknown): void {
    console.error(
        message,
        err instanceof DiscordHttpError
            ? { error: err.message, status: err.status, code: err.code, errors: err.errors }
            : err,
    );
}
