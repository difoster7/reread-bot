import type { Plan } from "../src/plan.ts";
import type { Env } from "../src/config.ts";
import type { DiscordApi, ForumPost } from "../src/discord.ts";

/**
 * Three weekly Sunday sessions in January 2027 (PST, UTC-8), so with the
 * default post hour 9 each session posts at 17:00Z on its date:
 * 1: 2027-01-03 AAA "Prologue–Ch 2", 2: 2027-01-10 AAA "Ch 3–4 + Epilogue",
 * 3: 2027-01-17 BBB "Ch 1–3".
 */
export const TINY_PLAN: Plan = {
    name: "Tiny",
    startDate: "2027-01-03",
    intervalDays: 7,
    breaks: [],
    books: [
        {
            short: "AAA",
            title: "Book A",
            structure: { prologue: true, chapters: 4, epilogue: true },
            sessions: ["P-2", "3-E"],
        },
        {
            short: "BBB",
            title: "Book B",
            structure: { chapters: 3 },
            sessions: ["1-3"],
        },
    ],
};

export const IDS = {
    guild: "100000000000000001",
    channel: "100000000000000002",
    testChannel: "100000000000000003",
    role: "100000000000000009",
    tag: "200000000000000001",
};

export const PLANS: Record<string, Plan> = { tiny: TINY_PLAN };

/** In-memory stand-in for the subset of KVNamespace the bot uses. */
export class MemoryKV {
    readonly data = new Map<string, string>();

    async get(key: string, type?: "json"): Promise<unknown> {
        const value = this.data.get(key);
        if (value === undefined) return null;
        return type === "json" ? JSON.parse(value) : value;
    }

    async put(key: string, value: string): Promise<void> {
        this.data.set(key, value);
    }

    async delete(key: string): Promise<void> {
        this.data.delete(key);
    }
}

/** A valid forum-mode env for the tiny plan; `vars` override or add vars. */
export function baseEnv(vars: Record<string, unknown> = {}): Env {
    return {
        STATE: new MemoryKV() as unknown as KVNamespace,
        PLAN: "tiny",
        GUILD_ID: IDS.guild,
        CHANNEL_ID: IDS.channel,
        CHANNEL_MODE: "forum",
        DISCORD_BOT_TOKEN: "test-token",
        ...vars,
    };
}

export function kvOf(env: Env): MemoryKV {
    return env.STATE as unknown as MemoryKV;
}

/** Records calls; a method listed in `failures` throws that error (after recording). */
export class FakeDiscord implements DiscordApi {
    readonly calls: { method: string; args: unknown[] }[] = [];
    readonly failures = new Map<string, Error>();
    private threads = 0;
    private messages = 0;

    private record(method: string, args: unknown[]): void {
        this.calls.push({ method, args });
        const failure = this.failures.get(method);
        if (failure) throw failure;
    }

    async createForumPost(channelId: string, post: ForumPost): Promise<string> {
        this.record("createForumPost", [channelId, post]);
        return `thread-${++this.threads}`;
    }

    async createThread(channelId: string, name: string): Promise<string> {
        this.record("createThread", [channelId, name]);
        return `thread-${++this.threads}`;
    }

    async sendMessage(channelId: string, content: string, roleId?: string): Promise<string> {
        this.record("sendMessage", [channelId, content, roleId]);
        return `message-${++this.messages}`;
    }

    async archiveThread(threadId: string, locked: boolean): Promise<void> {
        this.record("archiveThread", [threadId, locked]);
    }

    async deleteChannel(channelId: string): Promise<void> {
        this.record("deleteChannel", [channelId]);
    }
}
