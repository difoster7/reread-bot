import { describe, expect, it } from "vitest";
import { buildSchedule } from "../src/plan.ts";
import {
    DEFAULT_TEMPLATES,
    renderPost,
    renderReminder,
    templateErrors,
    type RenderOptions,
} from "../src/render.ts";
import { TINY_PLAN } from "./fixtures.ts";

const sessions = buildSchedule(TINY_PLAN);
const opts = (overrides: Partial<RenderOptions> = {}): RenderOptions => ({
    templates: DEFAULT_TEMPLATES,
    spoilerPolicy: "",
    ...overrides,
});

describe("renderPost", () => {
    it("renders the default title and opening message", () => {
        expect(renderPost(opts(), sessions, sessions[0])).toEqual({
            title: "AAA · Session 1 · Prologue–Ch 2",
            content:
                "**Book A — Prologue–Ch 2**\n" +
                "Session 1 of 3 · Sunday, January 3, 2027\n\n" +
                "📖 **Read next:** Book A, Ch 3–4 + Epilogue — discussion opens Sunday, January 10, 2027.",
        });
    });

    it("includes the spoiler policy verbatim", () => {
        const { content } = renderPost(
            opts({ spoilerPolicy: "No spoilers past {range}." }),
            sessions,
            sessions[0],
        );
        expect(content).toContain("2027\n\nNo spoilers past {range}.\n\n📖");
    });

    it("uses the final text for the last session", () => {
        const { content } = renderPost(opts(), sessions, sessions[2]);
        expect(content.endsWith(DEFAULT_TEMPLATES.finalText)).toBe(true);
        expect(content).not.toContain("Read next");
    });

    it("prefixes the role ping", () => {
        const { content } = renderPost(opts({ roleId: "123" }), sessions, sessions[0]);
        expect(content.startsWith("<@&123>\n**Book A")).toBe(true);
    });

    it("truncates long titles to 100 characters", () => {
        const templates = { ...DEFAULT_TEMPLATES, threadTitle: `{range} ${"x".repeat(120)}` };
        const { title } = renderPost(opts({ templates }), sessions, sessions[0]);
        expect(title).toHaveLength(100);
        expect(title.endsWith("…")).toBe(true);
    });

    it("rejects messages over 2000 characters", () => {
        expect(() =>
            renderPost(opts({ spoilerPolicy: "x".repeat(2000) }), sessions, sessions[0]),
        ).toThrow(RangeError);
    });

    it("leaves literal braces alone", () => {
        const templates = {
            ...DEFAULT_TEMPLATES,
            opening: '{bookShort} {not a placeholder} {"a":1}',
        };
        expect(templateErrors(templates)).toEqual([]);
        expect(renderPost(opts({ templates }), sessions, sessions[0]).content).toBe(
            'AAA {not a placeholder} {"a":1}',
        );
    });
});

describe("renderReminder", () => {
    it("describes the upcoming session", () => {
        expect(renderReminder(DEFAULT_TEMPLATES, sessions[1])).toBe(
            "⏰ **Reminder:** next discussion opens Sunday, January 10, 2027 — Book A, Ch 3–4 + Epilogue.",
        );
    });
});

describe("templateErrors", () => {
    it("accepts the defaults", () => {
        expect(templateErrors(DEFAULT_TEMPLATES)).toEqual([]);
    });

    it("rejects unknown and disallowed placeholders", () => {
        const templates = {
            ...DEFAULT_TEMPLATES,
            opening: "{bookTitl}",
            threadTitle: "{nextDate}",
            finalText: "{n}",
        };
        expect(templateErrors(templates)).toEqual([
            "threadTitle: unknown or disallowed placeholder {nextDate}",
            "opening: unknown or disallowed placeholder {bookTitl}",
            "finalText: unknown or disallowed placeholder {n}",
        ]);
    });
});
