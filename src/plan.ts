import { addDays, isIsoDate } from "./dates.ts";

export interface BookStructure {
    prologue?: boolean;
    /** Chapter count; mutually exclusive with `parts`. */
    chapters?: number;
    /** Chapter count per part; numbering restarts each part. */
    parts?: number[];
    /** A single unnumbered epilogue "E". */
    epilogue?: boolean;
    /** Numbered epilogues "E1".."En"; exclusive with `epilogue`. */
    epilogues?: number;
}

export interface PlanBook {
    short: string;
    title: string;
    structure: BookStructure;
    /** "start-end" unit ranges, in reading order. */
    sessions: string[];
}

export interface PlanBreak {
    from: string;
    to: string;
}

export interface Plan {
    name: string;
    startDate: string;
    intervalDays: number;
    breaks: PlanBreak[];
    books: PlanBook[];
}

export interface Session {
    n: number;
    /** Discussion date, YYYY-MM-DD. */
    date: string;
    book: { short: string; title: string };
    startUnit: string;
    endUnit: string;
    range: string;
}

/** Expands a book structure into its ordered list of unit IDs. */
export function expandUnits(structure: BookStructure): string[] {
    const units: string[] = [];
    if (structure.prologue) units.push("P");
    for (let c = 1; c <= (structure.chapters ?? 0); c++) units.push(String(c));
    (structure.parts ?? []).forEach((count, i) => {
        for (let c = 1; c <= count; c++) units.push(`${i + 1}.${c}`);
    });
    if (structure.epilogue) units.push("E");
    for (let e = 1; e <= (structure.epilogues ?? 0); e++) units.push(`E${e}`);
    return units;
}

/** Splits "start-end" into its two unit IDs, or null if malformed. */
export function parseRange(range: string): [string, string] | null {
    const parts = range.split("-");
    return parts.length === 2 && parts[0] !== "" && parts[1] !== ""
        ? [parts[0], parts[1]]
        : null;
}

function span(first: string, last: string): string {
    return first === last ? first : `${first}–${last}`;
}

/** Human label for units `start`..`end`, e.g. "Ch 36–38 + Epilogue". */
export function rangeLabel(units: string[], start: string, end: string): string {
    const covered = units.slice(units.indexOf(start), units.indexOf(end) + 1);
    const epilogues = covered.filter((u) => /^E\d*$/.test(u));
    const body = covered.filter((u) => u !== "P" && !epilogues.includes(u));
    const labels: string[] = [];
    if (body.length > 0) {
        labels.push(bodyLabel(units, body, start === "P"));
    } else if (start === "P") {
        labels.push("Prologue");
    }
    if (epilogues.length > 0) labels.push(epilogueLabel(epilogues));
    return labels.join(" + ");
}

function bodyLabel(units: string[], body: string[], withPrologue: boolean): string {
    const first = body[0];
    const last = body[body.length - 1];
    if (!first.includes(".")) {
        return withPrologue ? `Prologue–Ch ${last}` : `Ch ${span(first, last)}`;
    }
    const firstPart = first.split(".")[0];
    const lastPart = last.split(".")[0];
    const lastOfPart = units.filter((u) => u.startsWith(`${lastPart}.`)).at(-1);
    const wholeParts = first === `${firstPart}.1` && last === lastOfPart;
    const label = wholeParts
        ? `Part${firstPart === lastPart ? "" : "s"} ${span(firstPart, lastPart)}`
        : `Ch ${span(first, last)}`;
    return withPrologue ? `Prologue + ${label}` : label;
}

function epilogueLabel(epilogues: string[]): string {
    if (epilogues[0] === "E") return "Epilogue";
    const nums = epilogues.map((e) => e.slice(1));
    return nums.length === 1
        ? `Epilogue ${nums[0]}`
        : `Epilogues ${span(nums[0], nums[nums.length - 1])}`;
}

function isPositiveInt(value: unknown): boolean {
    return Number.isInteger(value) && (value as number) > 0;
}

function structureErrors(s: BookStructure): string[] {
    const errors: string[] = [];
    if ((s.chapters === undefined) === (s.parts === undefined)) {
        errors.push("structure needs exactly one of chapters or parts");
    }
    if (s.chapters !== undefined && !isPositiveInt(s.chapters)) {
        errors.push("chapters must be a positive integer");
    }
    if (s.parts !== undefined && (s.parts.length === 0 || !s.parts.every(isPositiveInt))) {
        errors.push("parts must be a non-empty list of positive integers");
    }
    if (s.epilogue && s.epilogues !== undefined) {
        errors.push("use epilogue or epilogues, not both");
    }
    if (s.epilogues !== undefined && !isPositiveInt(s.epilogues)) {
        errors.push("epilogues must be a positive integer");
    }
    return errors;
}

function bookErrors(book: PlanBook): string[] {
    const where = `book ${book.short}`;
    const structural = structureErrors(book.structure);
    if (structural.length > 0) return structural.map((e) => `${where}: ${e}`);
    if (book.sessions.length === 0) return [`${where}: no sessions`];

    const units = expandUnits(book.structure);
    const errors: string[] = [];
    let next = 0; // index of the next unit that must be covered
    for (const range of book.sessions) {
        const parsed = parseRange(range);
        if (!parsed) return [...errors, `${where}: malformed range "${range}"`];
        const [start, end] = parsed.map((u) => units.indexOf(u));
        if (start < 0 || end < 0) {
            return [...errors, `${where}: range "${range}" references an unknown unit`];
        }
        if (end < start) {
            return [...errors, `${where}: range "${range}" ends before it starts`];
        }
        if (start > next) {
            const missing = units.slice(next, start).join(", ");
            errors.push(`${where}: gap before "${range}" (missing ${missing})`);
        } else if (start < next) {
            errors.push(`${where}: "${range}" overlaps or is out of order`);
        }
        next = Math.max(next, end + 1);
    }
    if (next < units.length) {
        errors.push(`${where}: units not covered: ${units.slice(next).join(", ")}`);
    }
    return errors;
}

/** Returns every problem with the plan; empty means valid. */
export function validatePlan(plan: Plan): string[] {
    const errors: string[] = [];
    if (!isIsoDate(plan.startDate)) {
        errors.push(`startDate "${plan.startDate}" is not a valid YYYY-MM-DD date`);
    }
    if (!isPositiveInt(plan.intervalDays)) {
        errors.push("intervalDays must be a positive integer");
    }
    plan.breaks.forEach((b, i) => {
        if (!isIsoDate(b.from) || !isIsoDate(b.to)) {
            errors.push(`break ${i + 1}: dates must be YYYY-MM-DD`);
        } else if (b.from > b.to) {
            errors.push(`break ${i + 1}: from is after to`);
        }
    });
    if (plan.books.length === 0) errors.push("plan has no books");
    const codes = new Set<string>();
    for (const book of plan.books) {
        if (codes.has(book.short)) errors.push(`duplicate book code "${book.short}"`);
        codes.add(book.short);
        errors.push(...bookErrors(book));
    }
    return errors;
}

/** Derives dated sessions from a plan. Throws if the plan is invalid. */
export function buildSchedule(plan: Plan): Session[] {
    const errors = validatePlan(plan);
    if (errors.length > 0) {
        throw new Error(`Invalid plan "${plan.name}":\n- ${errors.join("\n- ")}`);
    }
    const inBreak = (date: string): boolean =>
        plan.breaks.some((b) => b.from <= date && date <= b.to);
    const slotDate = (slot: number): string =>
        addDays(plan.startDate, slot * plan.intervalDays);

    const sessions: Session[] = [];
    let slot = 0;
    for (const book of plan.books) {
        const units = expandUnits(book.structure);
        for (const range of book.sessions) {
            while (inBreak(slotDate(slot))) slot++;
            const [startUnit, endUnit] = parseRange(range) as [string, string];
            sessions.push({
                n: sessions.length + 1,
                date: slotDate(slot),
                book: { short: book.short, title: book.title },
                startUnit,
                endUnit,
                range: rangeLabel(units, startUnit, endUnit),
            });
            slot++;
        }
    }
    return sessions;
}
