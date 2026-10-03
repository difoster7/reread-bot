import { buildSchedule, validatePlan, type Plan, type Session } from "./plan.ts";
import { DEFAULT_TEMPLATES, templateErrors, type Templates } from "./render.ts";

export type ChannelMode = "forum" | "text";

/** Worker bindings: the KV namespace plus wrangler vars and secrets. */
export interface Env {
    STATE: KVNamespace;
    [name: string]: unknown;
}

export interface Config {
    plan: Plan;
    sessions: Session[];
    guildId: string;
    channelId: string;
    channelMode: ChannelMode;
    timezone: string;
    postHour: number;
    postOffsetDays: number;
    roleId?: string;
    forumTags: Record<string, string>;
    lockPrevious: boolean;
    reminderDaysBefore: number;
    dryRun: boolean;
    testChannelId?: string;
    testChannelMode: ChannelMode;
    spoilerPolicy: string;
    templates: Templates;
    token?: string;
}

export class ConfigError extends Error {
    readonly problems: string[];

    constructor(problems: string[]) {
        super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
        this.name = "ConfigError";
        this.problems = problems;
    }
}

const SNOWFLAKE = /^\d{17,20}$/;

function parseForumTags(
    raw: string,
    plan: Plan | undefined,
    problems: string[],
): Record<string, string> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        parsed = undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        problems.push('FORUM_TAGS must be a JSON object like {"TFE":"<tagId>"}');
        return {};
    }
    const tags: Record<string, string> = {};
    for (const [code, tag] of Object.entries(parsed as Record<string, unknown>)) {
        if (plan && !plan.books.some((b) => b.short === code)) {
            problems.push(`FORUM_TAGS key "${code}" is not a book code in the plan`);
        }
        if (typeof tag !== "string" || !SNOWFLAKE.test(tag)) {
            problems.push(`FORUM_TAGS["${code}"] must be a Discord ID string`);
        } else {
            tags[code] = tag;
        }
    }
    return tags;
}

/** Parses and validates vars/secrets. Throws ConfigError listing all problems. */
export function parseConfig(env: Env, plans: Record<string, Plan>): Config {
    const problems: string[] = [];

    // wrangler.toml vars may be numbers, booleans or tables; "" means unset.
    const read = (name: string, fallback = ""): string => {
        const raw = env[name];
        if (raw === undefined || raw === null) return fallback;
        const value = typeof raw === "object" ? JSON.stringify(raw) : String(raw).trim();
        return value === "" ? fallback : value;
    };
    const id = (name: string, required: boolean): string | undefined => {
        const value = read(name);
        if (value === "") {
            if (required) problems.push(`${name} is required`);
            return undefined;
        }
        if (!SNOWFLAKE.test(value)) problems.push(`${name} must be a Discord ID (17-20 digits)`);
        return value;
    };
    const int = (name: string, fallback: number, min: number, max: number): number => {
        const value = read(name, String(fallback));
        const n = Number(value);
        if (!/^-?\d+$/.test(value) || n < min || n > max) {
            problems.push(`${name} must be an integer from ${min} to ${max}`);
            return fallback;
        }
        return n;
    };
    const bool = (name: string, fallback: boolean): boolean => {
        const value = read(name, String(fallback));
        if (value !== "true" && value !== "false") {
            problems.push(`${name} must be "true" or "false"`);
            return fallback;
        }
        return value === "true";
    };
    const mode = (name: string, fallback = ""): ChannelMode => {
        const value = read(name, fallback);
        if (value !== "forum" && value !== "text") {
            problems.push(`${name} must be "forum" or "text"`);
            return "forum";
        }
        return value;
    };

    const planName = read("PLAN");
    const plan = Object.hasOwn(plans, planName) ? plans[planName] : undefined;
    if (!plan) {
        problems.push(`PLAN "${planName}" is not one of: ${Object.keys(plans).join(", ")}`);
    } else {
        problems.push(...validatePlan(plan).map((p) => `plan "${planName}": ${p}`));
    }

    const guildId = id("GUILD_ID", true);
    const channelId = id("CHANNEL_ID", true);
    const channelMode = mode("CHANNEL_MODE");
    const timezone = read("TIMEZONE", "America/Los_Angeles");
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
        problems.push(`TIMEZONE "${timezone}" is not a valid IANA time zone`);
    }
    const postHour = int("POST_HOUR", 9, 0, 23);
    const postOffsetDays = int("POST_OFFSET_DAYS", 0, -365, 365);
    const roleId = id("ROLE_ID", false);
    const forumTags = parseForumTags(read("FORUM_TAGS", "{}"), plan, problems);
    const lockPrevious = bool("LOCK_PREVIOUS", true);
    const reminderDaysBefore = int("REMINDER_DAYS_BEFORE", 3, 0, 365);
    if (plan && reminderDaysBefore >= plan.intervalDays) {
        problems.push(
            `REMINDER_DAYS_BEFORE must be less than the plan's intervalDays (${plan.intervalDays})`,
        );
    }
    const dryRun = bool("DRY_RUN", false);
    const testChannelId = id("TEST_CHANNEL_ID", false);
    const testChannelMode = mode("TEST_CHANNEL_MODE", channelMode);
    const templates: Templates = {
        threadTitle: read("THREAD_TITLE_TEMPLATE", DEFAULT_TEMPLATES.threadTitle),
        opening: read("OPENING_TEMPLATE", DEFAULT_TEMPLATES.opening),
        next: read("NEXT_TEMPLATE", DEFAULT_TEMPLATES.next),
        finalText: read("FINAL_TEXT", DEFAULT_TEMPLATES.finalText),
        reminder: read("REMINDER_TEMPLATE", DEFAULT_TEMPLATES.reminder),
    };
    problems.push(...templateErrors(templates));
    const token = read("DISCORD_BOT_TOKEN") || undefined;
    if (!token && !dryRun) {
        problems.push("DISCORD_BOT_TOKEN secret is required unless DRY_RUN is true");
    }

    if (problems.length > 0 || !plan || !guildId || !channelId) {
        throw new ConfigError(problems);
    }
    return {
        plan,
        sessions: buildSchedule(plan),
        guildId,
        channelId,
        channelMode,
        timezone,
        postHour,
        postOffsetDays,
        roleId,
        forumTags,
        lockPrevious,
        reminderDaysBefore,
        dryRun,
        testChannelId,
        testChannelMode,
        spoilerPolicy: read("SPOILER_POLICY"),
        templates,
        token,
    };
}
