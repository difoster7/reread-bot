import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.ts";
import { DEFAULT_TEMPLATES } from "../src/render.ts";
import { baseEnv, IDS, PLANS } from "./fixtures.ts";

function problems(vars: Record<string, unknown>): string[] {
    try {
        parseConfig(baseEnv(vars), PLANS);
    } catch (err) {
        if (err instanceof ConfigError) return err.problems;
        throw err;
    }
    return [];
}

describe("parseConfig", () => {
    it("applies defaults", () => {
        const cfg = parseConfig(baseEnv(), PLANS);
        expect(cfg).toMatchObject({
            guildId: IDS.guild,
            channelId: IDS.channel,
            channelMode: "forum",
            timezone: "America/Los_Angeles",
            postHour: 9,
            postOffsetDays: 0,
            forumTags: {},
            lockPrevious: true,
            reminderDaysBefore: 3,
            dryRun: false,
            testChannelMode: "forum",
            spoilerPolicy: "",
            templates: DEFAULT_TEMPLATES,
            token: "test-token",
        });
        expect(cfg.roleId).toBeUndefined();
        expect(cfg.testChannelId).toBeUndefined();
        expect(cfg.sessions).toHaveLength(3);
    });

    it("collects every problem at once", () => {
        expect(
            problems({
                PLAN: "nope",
                GUILD_ID: "abc",
                CHANNEL_ID: "",
                CHANNEL_MODE: "voice",
                TIMEZONE: "Mars/Base",
                POST_HOUR: "24",
                LOCK_PREVIOUS: "yes",
            }),
        ).toEqual(
            expect.arrayContaining([
                'PLAN "nope" is not one of: tiny',
                "GUILD_ID must be a Discord ID (17-20 digits)",
                "CHANNEL_ID is required",
                'CHANNEL_MODE must be "forum" or "text"',
                'TIMEZONE "Mars/Base" is not a valid IANA time zone',
                "POST_HOUR must be an integer from 0 to 23",
                'LOCK_PREVIOUS must be "true" or "false"',
            ]),
        );
    });

    it("validates FORUM_TAGS", () => {
        expect(problems({ FORUM_TAGS: "[1]" })).toEqual([
            'FORUM_TAGS must be a JSON object like {"TFE":"<tagId>"}',
        ]);
        expect(problems({ FORUM_TAGS: JSON.stringify({ ZZZ: IDS.tag, AAA: "x" }) })).toEqual([
            'FORUM_TAGS key "ZZZ" is not a book code in the plan',
            'FORUM_TAGS["AAA"] must be a Discord ID string',
        ]);
    });

    it("requires reminders to land inside the current window", () => {
        expect(problems({ REMINDER_DAYS_BEFORE: "7" })).toEqual([
            "REMINDER_DAYS_BEFORE must be less than the plan's intervalDays (7)",
        ]);
    });

    it("rejects unknown template placeholders", () => {
        expect(problems({ OPENING_TEMPLATE: "{bookTitl}" })).toEqual([
            "opening: unknown or disallowed placeholder {bookTitl}",
        ]);
    });

    it("requires the bot token unless dry run", () => {
        expect(problems({ DISCORD_BOT_TOKEN: "" })).toEqual([
            "DISCORD_BOT_TOKEN secret is required unless DRY_RUN is true",
        ]);
        expect(problems({ DISCORD_BOT_TOKEN: "", DRY_RUN: "true" })).toEqual([]);
    });

    it("surfaces plan validation errors", () => {
        const tiny = PLANS.tiny;
        const broken = { ...tiny, books: [{ ...tiny.books[0], sessions: ["P-2"] }] };
        expect(() => parseConfig(baseEnv(), { tiny: broken })).toThrow(
            'plan "tiny": book AAA: units not covered: 3, 4, E',
        );
    });

    it("defaults TEST_CHANNEL_MODE to CHANNEL_MODE", () => {
        expect(parseConfig(baseEnv({ CHANNEL_MODE: "text" }), PLANS).testChannelMode).toBe("text");
    });

    it("accepts non-string values from wrangler.toml", () => {
        const cfg = parseConfig(
            baseEnv({ POST_HOUR: 7, LOCK_PREVIOUS: false, FORUM_TAGS: { AAA: IDS.tag } }),
            PLANS,
        );
        expect(cfg).toMatchObject({
            postHour: 7,
            lockPrevious: false,
            forumTags: { AAA: IDS.tag },
        });
    });

    it("treats empty strings as unset", () => {
        const cfg = parseConfig(
            baseEnv({ ROLE_ID: "", FORUM_TAGS: "", TIMEZONE: "", TEST_CHANNEL_ID: "" }),
            PLANS,
        );
        expect(cfg).toMatchObject({ forumTags: {}, timezone: "America/Los_Angeles" });
        expect(cfg.roleId).toBeUndefined();
        expect(cfg.testChannelId).toBeUndefined();
    });
});
