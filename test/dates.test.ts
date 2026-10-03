import { describe, expect, it } from "vitest";
import { addDays, isIsoDate } from "../src/dates.ts";

describe("isIsoDate", () => {
    it.each(["2026-10-18", "2028-02-29"])("accepts %s", (value) => {
        expect(isIsoDate(value)).toBe(true);
    });

    it.each(["2027-02-29", "2027-02-30", "2027-1-1", "2027-13-01", "nope", ""])(
        "rejects %s",
        (value) => {
            expect(isIsoDate(value)).toBe(false);
        },
    );
});

describe("addDays", () => {
    it.each([
        ["2026-10-18", 14, "2026-11-01"],
        ["2026-12-27", 7, "2027-01-03"],
        ["2028-02-28", 1, "2028-02-29"],
        ["2026-10-18", -14, "2026-10-04"],
        ["2026-10-18", 756, "2028-11-12"],
    ])("%s + %i = %s", (date, days, expected) => {
        expect(addDays(date, days)).toBe(expected);
    });
});
