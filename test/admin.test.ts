import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/admin.ts";
import { DiscordHttpError } from "../src/discord.ts";
import { baseEnv, FakeDiscord, IDS, kvOf, PLANS } from "./fixtures.ts";

const SECRET = "s3cret";
const BEFORE_FIRST = Date.parse("2027-01-02T17:00:00Z");

async function call(
    path: string,
    opts: { method?: string; secret?: string; vars?: Record<string, unknown>; discord?: FakeDiscord } = {},
) {
    const env = baseEnv({ ADMIN_SECRET: SECRET, TEST_CHANNEL_ID: IDS.testChannel, ...opts.vars });
    const discord = opts.discord ?? new FakeDiscord();
    const request = new Request(`https://bot.example${path}`, {
        method: opts.method ?? "GET",
        headers: { "X-Admin-Secret": opts.secret ?? SECRET },
    });
    const response = await handleRequest(request, env, PLANS, BEFORE_FIRST, discord);
    const body = response.headers.get("Content-Type")?.includes("json")
        ? await response.json<Record<string, unknown>>()
        : await response.text();
    return { status: response.status, body, discord, kv: kvOf(env) };
}

describe("admin route", () => {
    it("is 404 everywhere when ADMIN_SECRET is unset", async () => {
        expect((await call("/admin/preview", { vars: { ADMIN_SECRET: "" } })).status).toBe(404);
    });

    it("is 404 outside /admin/", async () => {
        expect((await call("/")).status).toBe(404);
    });

    it("rejects a wrong secret", async () => {
        expect((await call("/admin/preview", { secret: "wrong" })).status).toBe(401);
    });

    it("previews the next session by default", async () => {
        const { status, body } = await call("/admin/preview");
        expect(status).toBe(200);
        expect(body).toMatchObject({
            session: { n: 1 },
            postDate: "2027-01-03",
            title: "AAA · Session 1 · Prologue–Ch 2",
            reminder: expect.stringContaining("Ch 3–4 + Epilogue"),
            record: null,
        });
    });

    it("previews a chosen session", async () => {
        const { body } = await call("/admin/preview?session=3");
        expect(body).toMatchObject({ session: { n: 3 }, reminder: null });
        expect((body as { content: string }).content).toContain("Thanks for reading along");
    });

    it("rejects an unknown session", async () => {
        expect((await call("/admin/preview?session=9")).status).toBe(400);
    });

    it("force-posts to the test channel only, without ping, tags or state", async () => {
        const { status, discord, kv } = await call("/admin/force-post?session=2", {
            method: "POST",
            vars: { ROLE_ID: IDS.role, FORUM_TAGS: JSON.stringify({ AAA: IDS.tag }) },
        });
        expect(status).toBe(200);
        expect(discord.calls).toEqual([
            {
                method: "createForumPost",
                args: [
                    IDS.testChannel,
                    {
                        name: "AAA · Session 2 · Ch 3–4 + Epilogue",
                        content: expect.not.stringContaining("<@&"),
                        tagIds: [],
                        roleId: undefined,
                    },
                ],
            },
        ]);
        expect(kv.data.size).toBe(0);
    });

    it("force-posts in text mode as thread plus message", async () => {
        const { discord } = await call("/admin/force-post?session=1", {
            method: "POST",
            vars: { TEST_CHANNEL_MODE: "text" },
        });
        expect(discord.calls.map((c) => c.method)).toEqual(["createThread", "sendMessage"]);
        expect(discord.calls[0].args[0]).toBe(IDS.testChannel);
    });

    it("needs TEST_CHANNEL_ID to force-post", async () => {
        const res = await call("/admin/force-post?session=1", {
            method: "POST",
            vars: { TEST_CHANNEL_ID: "" },
        });
        expect(res.status).toBe(400);
    });

    it("respects DRY_RUN when force-posting", async () => {
        const { status, body, discord } = await call("/admin/force-post?session=1", {
            method: "POST",
            vars: { DRY_RUN: "true" },
        });
        expect(status).toBe(200);
        expect(body).toMatchObject({ dryRun: true, channelId: IDS.testChannel });
        expect(discord.calls).toEqual([]);
    });

    it("reports Discord errors as 502", async () => {
        const discord = new FakeDiscord();
        discord.failures.set("createForumPost", new DiscordHttpError("POST", "/x", 403, { message: "Missing Access" }));
        const res = await call("/admin/force-post?session=1", { method: "POST", discord });
        expect(res.status).toBe(502);
        expect(res.body).toMatchObject({ error: expect.stringContaining("Missing Access") });
    });

    it("reports invalid configuration as 500", async () => {
        const { status, body } = await call("/admin/preview", { vars: { CHANNEL_MODE: "voice" } });
        expect(status).toBe(500);
        expect(body).toMatchObject({ problems: ['CHANNEL_MODE must be "forum" or "text"'] });
    });
});
