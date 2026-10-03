import { describe, expect, it } from "vitest";
import {
    isDue,
    localNow,
    pickReminder,
    pickThreadSession,
    skippedSessions,
    type Timing,
} from "../src/due.ts";
import type { Session } from "../src/plan.ts";

const LA = "America/Los_Angeles";
const at = (iso: string) => localNow(Date.parse(iso), LA);
const mk = (n: number, date: string): Session => ({
    n,
    date,
    book: { short: "X", title: "X" },
    startUnit: "1",
    endUnit: "1",
    range: "Ch 1",
});
const timing = (overrides: Partial<Timing> = {}): Timing => ({
    postHour: 9,
    postOffsetDays: 0,
    reminderDaysBefore: 3,
    ...overrides,
});
// Session 1 is on the 2027 spring-forward day.
const SESSIONS = [mk(1, "2027-03-14"), mk(2, "2027-03-28"), mk(3, "2027-04-11")];

describe("localNow", () => {
    it("converts an instant to the local date and hour", () => {
        expect(at("2027-01-03T08:00:00Z")).toEqual({ today: "2027-01-03", hour: 0 });
        expect(at("2027-01-03T07:59:00Z")).toEqual({ today: "2027-01-02", hour: 23 });
    });
});

describe("isDue", () => {
    const now = { today: "2027-01-03", hour: 9 };
    it("is due on the day at or after the post hour", () => {
        expect(isDue("2027-01-03", now, 9)).toBe(true);
        expect(isDue("2027-01-03", { ...now, hour: 8 }, 9)).toBe(false);
    });
    it("is due on any earlier date and not on later dates", () => {
        expect(isDue("2027-01-02", { ...now, hour: 0 }, 9)).toBe(true);
        expect(isDue("2027-01-04", { ...now, hour: 23 }, 9)).toBe(false);
    });
});

describe("pickThreadSession", () => {
    it("returns nothing before the first session", () => {
        expect(pickThreadSession(SESSIONS, at("2027-03-01T17:00:00Z"), timing())).toBeUndefined();
    });

    it("handles the spring-forward gap (02:00 does not exist)", () => {
        const t = timing({ postHour: 2 });
        // 09:00Z = 01:00 PST; 10:00Z = 03:00 PDT.
        expect(pickThreadSession(SESSIONS, at("2027-03-14T09:00:00Z"), t)).toBeUndefined();
        expect(pickThreadSession(SESSIONS, at("2027-03-14T10:00:00Z"), t)?.n).toBe(1);
    });

    it("handles the fall-back repeated hour (01:00 happens twice)", () => {
        const sessions = [mk(1, "2027-11-07")];
        const t = timing({ postHour: 1 });
        expect(pickThreadSession(sessions, at("2027-11-07T07:00:00Z"), t)).toBeUndefined();
        expect(pickThreadSession(sessions, at("2027-11-07T08:00:00Z"), t)?.n).toBe(1);
        expect(pickThreadSession(sessions, at("2027-11-07T09:00:00Z"), t)?.n).toBe(1);
    });

    it("applies the post offset", () => {
        // Session 2 (03-28) posts 14 days early, on 03-14 at 09:00 PDT (16:00Z).
        const t = timing({ postOffsetDays: -14 });
        expect(pickThreadSession(SESSIONS, at("2027-03-14T16:00:00Z"), t)?.n).toBe(2);
        expect(pickThreadSession(SESSIONS, at("2027-03-14T15:00:00Z"), t)?.n).toBe(1);
    });

    it("picks only the most recent due session after missed runs", () => {
        const target = pickThreadSession(SESSIONS, at("2027-04-12T17:00:00Z"), timing());
        expect(target?.n).toBe(3);
        expect(skippedSessions(SESSIONS, 1, target!).map((s) => s.n)).toEqual([2]);
        expect(skippedSessions(SESSIONS, 0, target!).map((s) => s.n)).toEqual([1, 2]);
    });
});

describe("pickReminder", () => {
    // Session 2 posts 03-28; reminder 3 days earlier, 03-25 09:00 PDT = 16:00Z.
    it("is due N days before the next session's post date", () => {
        expect(pickReminder(SESSIONS, at("2027-03-25T15:00:00Z"), timing())).toBeUndefined();
        expect(pickReminder(SESSIONS, at("2027-03-25T16:00:00Z"), timing())?.n).toBe(2);
    });

    it("is disabled when reminderDaysBefore is 0", () => {
        const t = timing({ reminderDaysBefore: 0 });
        expect(pickReminder(SESSIONS, at("2027-03-27T16:00:00Z"), t)).toBeUndefined();
    });

    it("returns nothing once every session is due", () => {
        expect(pickReminder(SESSIONS, at("2030-01-01T17:00:00Z"), timing())).toBeUndefined();
    });
});
