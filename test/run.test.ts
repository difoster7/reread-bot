import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.ts";
import { DiscordHttpError, DiscordNetworkError } from "../src/discord.ts";
import { runScheduled } from "../src/run.ts";
import { baseEnv, FakeDiscord, IDS, kvOf, PLANS } from "./fixtures.ts";

// Tiny plan sessions post at 09:00 Los Angeles = 17:00Z in January 2027.
const DAY1 = Date.parse("2027-01-03T17:00:00Z");
const DAY2 = Date.parse("2027-01-10T17:00:00Z");
const DAY3 = Date.parse("2027-01-17T17:00:00Z");
const REMIND2 = Date.parse("2027-01-07T17:00:00Z");
const HOUR = 3_600_000;

function setup(vars: Record<string, unknown> = {}) {
    const env = baseEnv(vars);
    const cfg = parseConfig(env, PLANS);
    const discord = new FakeDiscord();
    const run = (instant: number) => runScheduled(cfg, env.STATE, discord, instant);
    return { discord, kv: kvOf(env), run };
}

const methods = (d: FakeDiscord) => d.calls.map((c) => c.method);
const record = (kv: ReturnType<typeof kvOf>, key: string) =>
    JSON.parse(kv.data.get(key) ?? "null");

beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("thread step", () => {
    it("does nothing before the first session is due", async () => {
        const { discord, kv, run } = setup();
        await run(DAY1 - HOUR);
        expect(discord.calls).toEqual([]);
        expect(kv.data.size).toBe(0);
    });

    it("opens the due session once and records it", async () => {
        const { discord, kv, run } = setup();
        await run(DAY1);
        await run(DAY1 + HOUR);
        expect(discord.calls).toEqual([
            {
                method: "createForumPost",
                args: [
                    IDS.channel,
                    {
                        name: "AAA · Session 1 · Prologue–Ch 2",
                        content: expect.stringContaining("Session 1 of 3"),
                        tagIds: [],
                        roleId: undefined,
                    },
                ],
            },
        ]);
        expect(record(kv, "session:1")).toMatchObject({ status: "posted", threadId: "thread-1" });
        expect(record(kv, "latest")).toEqual({ n: 1, threadId: "thread-1" });
    });

    it("posts only the most recent due session after missed runs", async () => {
        const { discord, run } = setup();
        await run(DAY3);
        expect(methods(discord)).toEqual(["createForumPost"]);
        expect(discord.calls[0].args[1]).toMatchObject({ name: "BBB · Session 3 · Ch 1–3" });
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Session 1 "));
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Session 2 "));
    });

    it("is a silent no-op after the final session", async () => {
        const { discord, run } = setup();
        await run(DAY3);
        const later = Date.parse("2030-06-01T17:00:00Z");
        await run(later);
        await run(later + HOUR);
        expect(methods(discord)).toEqual(["createForumPost"]);
        expect(console.error).not.toHaveBeenCalled();
    });

    it("locks the previous thread when the next session opens", async () => {
        const { discord, run } = setup();
        await run(DAY1);
        await run(DAY2);
        expect(discord.calls.at(-1)).toEqual({ method: "archiveThread", args: ["thread-1", true] });
    });

    it("leaves the previous thread open when LOCK_PREVIOUS is false", async () => {
        const { discord, run } = setup({ LOCK_PREVIOUS: "false" });
        await run(DAY1);
        await run(DAY2);
        expect(methods(discord)).toEqual(["createForumPost", "createForumPost"]);
    });

    it("pings the role and applies the book's forum tag", async () => {
        const { discord, run } = setup({
            ROLE_ID: IDS.role,
            FORUM_TAGS: JSON.stringify({ AAA: IDS.tag }),
        });
        await run(DAY1);
        expect(discord.calls[0].args[1]).toMatchObject({
            tagIds: [IDS.tag],
            roleId: IDS.role,
            content: expect.stringMatching(new RegExp(`^<@&${IDS.role}>\n`)),
        });
    });

    it("releases the pending marker when Discord rejects the post", async () => {
        const { discord, kv, run } = setup();
        discord.failures.set("createForumPost", new DiscordHttpError("POST", "/x", 400, {}));
        await expect(run(DAY1)).rejects.toThrow();
        expect(kv.data.has("session:1")).toBe(false);
        discord.failures.clear();
        await run(DAY1 + HOUR);
        expect(record(kv, "session:1")).toMatchObject({ status: "posted" });
    });

    it("keeps the pending marker after a Discord server error", async () => {
        const { discord, kv, run } = setup();
        discord.failures.set("createForumPost", new DiscordHttpError("POST", "/x", 503, {}));
        await expect(run(DAY1)).rejects.toThrow();
        expect(record(kv, "session:1")).toMatchObject({ status: "pending" });
        discord.failures.clear();
        await expect(run(DAY1 + HOUR)).rejects.toThrow(/stuck pending/);
        expect(methods(discord)).toEqual(["createForumPost"]);
    });

    it("keeps the pending marker and stops retrying after an ambiguous failure", async () => {
        const { discord, kv, run } = setup();
        discord.failures.set(
            "createForumPost",
            new DiscordNetworkError("POST", "/x", new Error("timeout")),
        );
        await expect(run(DAY1)).rejects.toThrow();
        expect(record(kv, "session:1")).toMatchObject({ status: "pending" });
        discord.failures.clear();
        await expect(run(DAY1 + HOUR)).rejects.toThrow(/stuck pending/);
        expect(methods(discord)).toEqual(["createForumPost"]);
    });

    it("dry run reads state but never calls Discord or writes KV", async () => {
        const { discord, kv, run } = setup({ DRY_RUN: "true", DISCORD_BOT_TOKEN: "" });
        await run(DAY1);
        await run(REMIND2);
        expect(discord.calls).toEqual([]);
        expect(kv.data.size).toBe(0);
        expect(console.log).toHaveBeenCalledWith(
            expect.stringContaining("[dry-run] would open session 1"),
            expect.anything(),
        );
    });
});

describe("thread step in text mode", () => {
    it("creates a thread, then posts the opening message", async () => {
        const { discord, run } = setup({ CHANNEL_MODE: "text", ROLE_ID: IDS.role });
        await run(DAY1);
        expect(methods(discord)).toEqual(["createThread", "sendMessage"]);
        expect(discord.calls[1].args).toEqual([
            "thread-1",
            expect.stringContaining("Session 1 of 3"),
            IDS.role,
        ]);
    });

    it("deletes the empty thread if the opening message is rejected", async () => {
        const { discord, kv, run } = setup({ CHANNEL_MODE: "text" });
        discord.failures.set("sendMessage", new DiscordHttpError("POST", "/x", 403, {}));
        await expect(run(DAY1)).rejects.toThrow();
        expect(methods(discord)).toEqual(["createThread", "sendMessage", "deleteChannel"]);
        expect(kv.data.has("session:1")).toBe(false);
    });

    it("records the thread if it cannot be deleted", async () => {
        const { discord, kv, run } = setup({ CHANNEL_MODE: "text" });
        discord.failures.set("sendMessage", new DiscordHttpError("POST", "/x", 403, {}));
        discord.failures.set("deleteChannel", new DiscordHttpError("DELETE", "/x", 403, {}));
        await expect(run(DAY1)).rejects.toThrow();
        expect(record(kv, "session:1")).toMatchObject({ status: "posted", threadId: "thread-1" });
    });
});

describe("reminder step", () => {
    it("posts one reminder in the current thread before the next session", async () => {
        const { discord, kv, run } = setup();
        await run(DAY1);
        await run(REMIND2);
        await run(REMIND2 + HOUR);
        expect(discord.calls.slice(1)).toEqual([
            {
                method: "sendMessage",
                args: ["thread-1", expect.stringContaining("**Reminder:**"), undefined],
            },
        ]);
        expect(record(kv, "reminder:2")).toMatchObject({ messageId: "message-1" });
    });

    it("sends no reminder before the first thread exists", async () => {
        const { discord, run } = setup();
        await run(Date.parse("2026-12-31T17:00:00Z"));
        expect(discord.calls).toEqual([]);
    });
});
