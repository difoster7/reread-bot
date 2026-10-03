import { describe, expect, it } from "vitest";
import {
    buildSchedule,
    expandUnits,
    rangeLabel,
    validatePlan,
    type Plan,
} from "../src/plan.ts";

const TFE_UNITS = expandUnits({ prologue: true, chapters: 38, epilogue: true });
const SH_UNITS = expandUnits({ parts: [2, 4, 3, 4, 3, 9], epilogue: true });
const TLM_UNITS = expandUnits({ prologue: true, chapters: 74, epilogues: 7 });

function plan(overrides: Partial<Plan> = {}): Plan {
    return {
        name: "Test",
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
        ...overrides,
    };
}

function withSessions(sessions: string[]): Plan {
    const base = plan();
    return { ...base, books: [{ ...base.books[0], sessions }, base.books[1]] };
}

describe("expandUnits", () => {
    it("lists prologue, chapters and epilogue in order", () => {
        expect(
            expandUnits({ prologue: true, chapters: 3, epilogue: true }),
        ).toEqual(["P", "1", "2", "3", "E"]);
    });

    it("restarts chapter numbering in each part", () => {
        expect(expandUnits({ parts: [2, 1] })).toEqual(["1.1", "1.2", "2.1"]);
    });

    it("numbers multiple epilogues", () => {
        expect(expandUnits({ chapters: 1, epilogues: 2 })).toEqual([
            "1",
            "E1",
            "E2",
        ]);
    });
});

describe("rangeLabel", () => {
    it.each([
        ["P", "3", "Prologue–Ch 3", TFE_UNITS],
        ["8", "11", "Ch 8–11", TFE_UNITS],
        ["5", "5", "Ch 5", TFE_UNITS],
        ["36", "E", "Ch 36–38 + Epilogue", TFE_UNITS],
        ["P", "P", "Prologue", TFE_UNITS],
        ["1.1", "3.3", "Parts 1–3", SH_UNITS],
        ["4.1", "E", "Parts 4–6 + Epilogue", SH_UNITS],
        ["2.1", "2.4", "Part 2", SH_UNITS],
        ["1.2", "2.3", "Ch 1.2–2.3", SH_UNITS],
        ["71", "E7", "Ch 71–74 + Epilogues 1–7", TLM_UNITS],
        ["E3", "E3", "Epilogue 3", TLM_UNITS],
    ])("%s-%s → %s", (start, end, label, units) => {
        expect(rangeLabel(units, start, end)).toBe(label);
    });
});

describe("validatePlan", () => {
    it("accepts a complete plan", () => {
        expect(validatePlan(plan())).toEqual([]);
    });

    it.each([
        ["a gap", ["P-1", "3-E"], 'book AAA: gap before "3-E" (missing 2)'],
        ["an overlap", ["P-2", "2-E"], 'book AAA: "2-E" overlaps or is out of order'],
        ["wrong order", ["3-E", "P-2"], 'book AAA: "P-2" overlaps or is out of order'],
        ["an uncovered tail", ["P-2"], "book AAA: units not covered: 3, 4, E"],
        ["an unknown unit", ["P-9"], 'book AAA: range "P-9" references an unknown unit'],
        ["a malformed range", ["P2"], 'book AAA: malformed range "P2"'],
        ["a reversed range", ["3-1"], 'book AAA: range "3-1" ends before it starts'],
        ["no sessions", [], "book AAA: no sessions"],
    ])("reports %s", (_name, sessions, message) => {
        expect(validatePlan(withSessions(sessions))).toContain(message);
    });

    it("reports a malformed structure", () => {
        const bad = plan();
        bad.books[1] = {
            ...bad.books[1],
            structure: { chapters: 3, parts: [1] },
        };
        expect(validatePlan(bad)).toContain(
            "book BBB: structure needs exactly one of chapters or parts",
        );
    });

    it("reports plan-level problems", () => {
        const book = plan().books[0];
        const errors = validatePlan(
            plan({
                startDate: "2027-02-30",
                intervalDays: 0,
                breaks: [{ from: "2027-02-01", to: "2027-01-01" }],
                books: [book, book],
            }),
        );
        expect(errors).toEqual(
            expect.arrayContaining([
                'startDate "2027-02-30" is not a valid YYYY-MM-DD date',
                "intervalDays must be a positive integer",
                "break 1: from is after to",
                'duplicate book code "AAA"',
            ]),
        );
    });
});

describe("buildSchedule", () => {
    it("numbers sessions across books and spaces them by the interval", () => {
        const a = { short: "AAA", title: "Book A" };
        expect(buildSchedule(plan())).toEqual([
            { n: 1, date: "2027-01-03", book: a, startUnit: "P", endUnit: "2", range: "Prologue–Ch 2" },
            { n: 2, date: "2027-01-10", book: a, startUnit: "3", endUnit: "E", range: "Ch 3–4 + Epilogue" },
            { n: 3, date: "2027-01-17", book: { short: "BBB", title: "Book B" }, startUnit: "1", endUnit: "3", range: "Ch 1–3" },
        ]);
    });

    it("skips slots that fall inside a break", () => {
        const breaks = [{ from: "2027-01-09", to: "2027-01-16" }];
        const dates = buildSchedule(plan({ breaks })).map((s) => s.date);
        expect(dates).toEqual(["2027-01-03", "2027-01-17", "2027-01-24"]);
    });

    it("throws on an invalid plan", () => {
        expect(() => buildSchedule(withSessions(["P-1"]))).toThrow(
            /Invalid plan "Test"/,
        );
    });
});
