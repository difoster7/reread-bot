import { describe, expect, it } from "vitest";
import mistborn from "../plans/mistborn.ts";
import { buildSchedule, expandUnits, validatePlan } from "../src/plan.ts";

const DAY_MS = 86_400_000;
const sessions = buildSchedule(mistborn);

describe("Mistborn plan", () => {
    it("is valid", () => {
        expect(validatePlan(mistborn)).toEqual([]);
    });

    it("has 55 sessions from 2026-10-18 to 2028-11-12", () => {
        expect(sessions).toHaveLength(55);
        expect(sessions[0].date).toBe("2026-10-18");
        expect(sessions[54].date).toBe("2028-11-12");
    });

    it("spaces sessions exactly 14 days apart, all on Sundays", () => {
        for (let i = 1; i < sessions.length; i++) {
            const gap = Date.parse(sessions[i].date) - Date.parse(sessions[i - 1].date);
            expect(gap / DAY_MS).toBe(14);
        }
        for (const s of sessions) {
            expect(new Date(`${s.date}T00:00:00Z`).getUTCDay()).toBe(0);
        }
    });

    it("reads the books in order", () => {
        expect([...new Set(sessions.map((s) => s.book.short))]).toEqual([
            "TFE", "WoA", "HoA", "SH", "AoL", "SoS", "BoM", "TLM",
        ]);
    });

    it("matches the book structures from the spec", () => {
        const unitCounts = Object.fromEntries(
            mistborn.books.map((b) => [b.short, expandUnits(b.structure).length]),
        );
        expect(unitCounts).toEqual({
            TFE: 40, WoA: 60, HoA: 84, SH: 26, AoL: 22, SoS: 28, BoM: 33, TLM: 82,
        });
    });

    it("covers every unit of every book exactly once, in order", () => {
        for (const book of mistborn.books) {
            const units = expandUnits(book.structure);
            const covered = sessions
                .filter((s) => s.book.short === book.short)
                .flatMap((s) =>
                    units.slice(units.indexOf(s.startUnit), units.indexOf(s.endUnit) + 1),
                );
            expect(covered).toEqual(units);
        }
    });

    it("labels sessions readably", () => {
        expect(sessions[0].range).toBe("Prologue–Ch 3");
        expect(sessions[2].range).toBe("Ch 8–11");
        expect(sessions[9].range).toBe("Ch 36–38 + Epilogue");
        expect(sessions[31].range).toBe("Parts 1–3");
        expect(sessions[32].range).toBe("Parts 4–6 + Epilogue");
        expect(sessions[54].range).toBe("Ch 71–74 + Epilogues 1–7");
    });
});
