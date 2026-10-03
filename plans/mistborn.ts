import type { Plan } from "../src/plan.ts";

// Draft schedule: dates and chunks may still change.
export default {
    name: "Mistborn Reread",
    startDate: "2026-10-18",
    intervalDays: 14,
    breaks: [],
    books: [
        {
            short: "TFE",
            title: "The Final Empire",
            structure: { prologue: true, chapters: 38, epilogue: true },
            sessions: [
                "P-3", "4-7", "8-11", "12-15", "16-19",
                "20-23", "24-27", "28-31", "32-35", "36-E",
            ],
        },
        {
            short: "WoA",
            title: "The Well of Ascension",
            structure: { chapters: 59, epilogue: true },
            sessions: [
                "1-6", "7-11", "12-17", "18-22", "23-28", "29-33",
                "34-39", "40-44", "45-50", "51-55", "56-E",
            ],
        },
        {
            short: "HoA",
            title: "The Hero of Ages",
            structure: { prologue: true, chapters: 82, epilogue: true },
            sessions: [
                "P-8", "9-16", "17-25", "26-33", "34-42",
                "43-50", "51-59", "60-67", "68-75", "76-E",
            ],
        },
        {
            short: "SH",
            title: "Secret History",
            structure: { parts: [2, 4, 3, 4, 3, 9], epilogue: true },
            sessions: ["1.1-3.3", "4.1-E"],
        },
        {
            short: "AoL",
            title: "The Alloy of Law",
            structure: { prologue: true, chapters: 20, epilogue: true },
            sessions: ["P-5", "6-11", "12-16", "17-E"],
        },
        {
            short: "SoS",
            title: "Shadows of Self",
            structure: { prologue: true, chapters: 26, epilogue: true },
            sessions: ["P-5", "6-11", "12-17", "18-22", "23-E"],
        },
        {
            short: "BoM",
            title: "The Bands of Mourning",
            structure: { prologue: true, chapters: 31, epilogue: true },
            sessions: ["P-5", "6-11", "12-17", "18-22", "23-27", "28-E"],
        },
        {
            short: "TLM",
            title: "The Lost Metal",
            structure: { prologue: true, chapters: 74, epilogues: 7 },
            sessions: [
                "P-11", "12-23", "24-35", "36-47", "48-59", "60-70", "71-E7",
            ],
        },
    ],
} satisfies Plan;
