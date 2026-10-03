import { describe, expect, it } from "vitest";
import {
    DiscordClient,
    DiscordHttpError,
    DiscordNetworkError,
} from "../src/discord.ts";

interface Captured {
    url: string;
    method: string;
    headers: Headers;
    body: unknown;
}

const json = (body: unknown, status = 200) => () =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });

function setup(responses: (() => Response)[]) {
    const requests: Captured[] = [];
    const sleeps: number[] = [];
    const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
        requests.push({
            url,
            method: init.method ?? "GET",
            headers: new Headers(init.headers),
            body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        const next = responses.shift();
        if (!next) throw new Error("unexpected request");
        return next();
    };
    const client = new DiscordClient("tok", fetchFn, async (ms) => {
        sleeps.push(ms);
    });
    return { client, requests, sleeps };
}

describe("DiscordClient", () => {
    it("creates a forum post with tags and safe mentions", async () => {
        const { client, requests } = setup([json({ id: "555" })]);
        await expect(
            client.createForumPost("123", { name: "T", content: "Hi", tagIds: ["9"] }),
        ).resolves.toBe("555");
        const [req] = requests;
        expect(req.url).toBe("https://discord.com/api/v10/channels/123/threads");
        expect(req.method).toBe("POST");
        expect(req.headers.get("Authorization")).toBe("Bot tok");
        expect(req.headers.get("User-Agent")).toMatch(/^DiscordBot \(/);
        expect(req.body).toEqual({
            name: "T",
            auto_archive_duration: 10080,
            message: { content: "Hi", allowed_mentions: { parse: [] } },
            applied_tags: ["9"],
        });
    });

    it("omits tags when there are none and allows only the pinged role", async () => {
        const { client, requests } = setup([json({ id: "555" })]);
        await client.createForumPost("123", { name: "T", content: "Hi", tagIds: [], roleId: "77" });
        expect(requests[0].body).toEqual({
            name: "T",
            auto_archive_duration: 10080,
            message: { content: "Hi", allowed_mentions: { parse: [], roles: ["77"] } },
        });
    });

    it("creates a public thread", async () => {
        const { client, requests } = setup([json({ id: "556" })]);
        await expect(client.createThread("123", "T")).resolves.toBe("556");
        expect(requests[0].body).toEqual({ name: "T", type: 11, auto_archive_duration: 10080 });
    });

    it("sends a message", async () => {
        const { client, requests } = setup([json({ id: "777" })]);
        await expect(client.sendMessage("42", "hello")).resolves.toBe("777");
        expect(requests[0].url).toBe("https://discord.com/api/v10/channels/42/messages");
        expect(requests[0].body).toEqual({ content: "hello", allowed_mentions: { parse: [] } });
    });

    it("archives and locks a thread", async () => {
        const { client, requests } = setup([json({ id: "42" })]);
        await client.archiveThread("42", true);
        expect(requests[0].method).toBe("PATCH");
        expect(requests[0].body).toEqual({ archived: true, locked: true });
    });

    it("deletes a channel, accepting 204", async () => {
        const { client, requests } = setup([() => new Response(null, { status: 204 })]);
        await expect(client.deleteChannel("42")).resolves.toBeUndefined();
        expect(requests[0].method).toBe("DELETE");
    });

    it("waits retry_after on 429 and retries", async () => {
        const { client, requests, sleeps } = setup([
            json({ message: "rate limited", retry_after: 1.5, global: false }, 429),
            json({ id: "1" }),
        ]);
        await expect(client.sendMessage("42", "x")).resolves.toBe("1");
        expect(sleeps).toEqual([1500]);
        expect(requests).toHaveLength(2);
    });

    it("falls back to Retry-After, then to 1 second", async () => {
        const { client, sleeps } = setup([
            () => new Response("", { status: 429, headers: { "Retry-After": "2" } }),
            () => new Response("", { status: 429 }),
            json({ id: "1" }),
        ]);
        await client.sendMessage("42", "x");
        expect(sleeps).toEqual([2000, 1000]);
    });

    it("gives up after 3 retries", async () => {
        const limited = json({ retry_after: 0.1 }, 429);
        const { client, requests, sleeps } = setup([limited, limited, limited, limited]);
        const err = await client.sendMessage("42", "x").catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DiscordHttpError);
        expect(err).toMatchObject({ status: 429 });
        expect(requests).toHaveLength(4);
        expect(sleeps).toHaveLength(3);
    });

    it("raises DiscordHttpError with Discord's error details", async () => {
        const { client } = setup([
            json({ code: 50013, message: "Missing Permissions", errors: { a: 1 } }, 403),
        ]);
        const err = await client.sendMessage("1", "x").catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DiscordHttpError);
        expect(err).toMatchObject({
            method: "POST",
            path: "/channels/1/messages",
            status: 403,
            code: 50013,
            errors: { a: 1 },
        });
        expect((err as Error).message).toContain("Missing Permissions");
    });

    it("raises DiscordNetworkError when the request does not complete", async () => {
        const { client } = setup([
            () => {
                throw new TypeError("network down");
            },
        ]);
        await expect(client.sendMessage("1", "x")).rejects.toBeInstanceOf(DiscordNetworkError);
    });
});
