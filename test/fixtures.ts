import type { Plan } from "../src/plan.ts";

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
