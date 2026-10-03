# Reread Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cloudflare Worker that, on an hourly cron, opens a Discord discussion thread for each session of a configurable book-club reading plan (first plan: a 55-session Mistborn reread) and posts a reading reminder before the next session.

**Architecture:** A reading plan (`plans/<name>.ts`) is pure data; `src/plan.ts` validates it and derives dated sessions. Each deployment is a wrangler environment whose `[vars]` are parsed by `src/config.ts`. The hourly `scheduled` handler (`src/run.ts`) picks the due session from local time (`src/due.ts`), renders templates (`src/render.ts`), and calls the Discord REST API (`src/discord.ts`), with idempotency state in Workers KV. An optional, secret-protected admin route (`src/admin.ts`) previews and test-posts sessions.

**Tech Stack:** TypeScript, Cloudflare Workers + Wrangler 4, Workers KV, Discord REST API v10 via `fetch`, Vitest (Node), Node ≥ 22.18 type stripping for scripts.

**Spec:** `docs/superpowers/specs/2026-10-02-reread-bot-design.md`

## Global Constraints

- No runtime dependencies. Dev dependencies only: `wrangler`, `typescript`, `vitest`, `@cloudflare/workers-types`.
- No discord.js, no Gateway, no slash commands, no privileged intents. REST only: `https://discord.com/api/v10`.
- Secrets (`DISCORD_BOT_TOKEN`, `ADMIN_SECRET`) only via `wrangler secret`; never committed.
- **Do not deploy, run `wrangler secret put`, create remote KV namespaces, or call the real Discord API.** All verification is local and dry-run.
- All relative imports use explicit `.ts` extensions (required so `scripts/schedule.ts` runs under Node type stripping).
- Only erasable TypeScript syntax (`erasableSyntaxOnly`): no enums, namespaces, or constructor parameter properties.
- 4-space indentation, double quotes, semicolons.
- Every commit message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work on branch `reread_bot` (already exists; spec committed there).
- Hourly cron `0 * * * *`; default timezone `America/Los_Angeles`; default post hour `9`.
- Discord limits: thread name ≤ 100 chars (truncate with `…`); message ≤ 2000 chars (error).
- `allowed_mentions` is sent on every message-creating call: `{ parse: [] }`, plus `roles: [ROLE_ID]` only when pinging.

### Deliberate deviations from the spec layout

- Date helpers (`isIsoDate`, `addDays`) live in `src/dates.ts` (not `due.ts`) to avoid a `plan.ts` ↔ `due.ts` import cycle.
- `DEFAULT_TEMPLATES` lives in `src/render.ts` (templates concern); `config.ts` imports it.
- The Discord client takes an injectable `sleep` instead of tests using fake timers.

## Review Focus

1. **Non-string vars from `wrangler.toml`** — someone writes `POST_HOUR = 9`, `LOCK_PREVIOUS = false`, or `FORUM_TAGS = { TFE = "…" }` unquoted; Wrangler passes numbers/booleans/objects. Expect them to work exactly like strings. (Task 5 test.)
2. **Empty-string vars** — `ROLE_ID = ""`, `FORUM_TAGS = ""`, `TIMEZONE = ""` should mean "unset / use the default", not a parse error. (Task 5 test.)
3. **Runs after the final session** — once the last session has posted, every hourly run for years afterward must be a silent no-op with no errors. (Task 7 test.)
4. **Literal braces in templates** — text like `{not a placeholder}` or `{"a":1}` must pass validation and render unchanged. (Task 4 test.)
5. **429 without retry info** — a 429 with no JSON body and no `Retry-After` header must back off (1 s) and retry, not crash or spin. (Task 6 test.)

---

### Task 1: Scaffold, date helpers, plan model

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `src/dates.ts`, `src/plan.ts`
- Test: `test/dates.test.ts`, `test/plan.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `isIsoDate(value: string): boolean`, `addDays(date: string, days: number): string` (`src/dates.ts`)
  - Types `BookStructure`, `PlanBook`, `PlanBreak`, `Plan`, `Session` (`src/plan.ts`)
  - `expandUnits(structure: BookStructure): string[]`
  - `parseRange(range: string): [string, string] | null`
  - `rangeLabel(units: string[], start: string, end: string): string`
  - `validatePlan(plan: Plan): string[]`
  - `buildSchedule(plan: Plan): Session[]` (throws `Error` on invalid plan)

- [ ] **Step 1: Create `package.json`**

```json
{
    "name": "reread-bot",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "engines": {
        "node": ">=22.18"
    },
    "scripts": {
        "dev": "wrangler dev --test-scheduled --var DRY_RUN:true",
        "deploy": "wrangler deploy",
        "schedule": "node scripts/schedule.ts",
        "test": "vitest run",
        "typecheck": "tsc --noEmit"
    }
}
```

- [ ] **Step 2: Install dev dependencies and verify toolchain**

Run: `npm install -D wrangler typescript vitest @cloudflare/workers-types`
Then: `npx tsc --version && npx vitest --version && npx wrangler --version`
Expected: three version strings. npm may warn that `esbuild`/`workerd` install scripts were not run (npm `allowScripts`). If any of the three commands fails with a missing-binary error, STOP and ask the user whether to run `npm install-scripts approve esbuild workerd` — do not approve on your own.

- [ ] **Step 3: Create `tsconfig.json` and `.gitignore`**

`tsconfig.json`:

```json
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "ESNext",
        "moduleResolution": "Bundler",
        "lib": ["ES2022"],
        "types": ["@cloudflare/workers-types"],
        "strict": true,
        "noEmit": true,
        "allowImportingTsExtensions": true,
        "erasableSyntaxOnly": true,
        "skipLibCheck": true
    },
    "include": ["src", "plans", "test"]
}
```

(`scripts/` is excluded: it uses Node's `process`, and adding `@types/node` would conflict with Workers types. It is verified by running it.)

`.gitignore`:

```
node_modules/
.wrangler/
.dev.vars
.env*
```

- [ ] **Step 4: Write failing tests for date helpers — `test/dates.test.ts`**

```ts
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
```

- [ ] **Step 5: Run to verify failure**

Run: `npx vitest run test/dates.test.ts`
Expected: FAIL — cannot resolve `../src/dates.ts`.

- [ ] **Step 6: Implement `src/dates.ts`**

```ts
const DAY_MS = 86_400_000;

/** True if `value` is a real calendar date in YYYY-MM-DD form. */
export function isIsoDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return (
        !Number.isNaN(date.getTime()) &&
        date.toISOString().startsWith(value)
    );
}

/** Adds whole days (may be negative) to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
    const ms = Date.parse(`${date}T00:00:00Z`) + days * DAY_MS;
    return new Date(ms).toISOString().slice(0, 10);
}
```

- [ ] **Step 7: Run to verify pass**

Run: `npx vitest run test/dates.test.ts`
Expected: PASS.

- [ ] **Step 8: Write failing tests for the plan model — `test/plan.test.ts`**

```ts
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
```

- [ ] **Step 9: Run to verify failure**

Run: `npx vitest run test/plan.test.ts`
Expected: FAIL — cannot resolve `../src/plan.ts`.

- [ ] **Step 10: Implement `src/plan.ts`**

```ts
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
```

- [ ] **Step 11: Run tests and typecheck**

Run: `npx vitest run test/dates.test.ts test/plan.test.ts && npx tsc --noEmit`
Expected: all PASS; tsc exits 0 with no output.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore src/dates.ts src/plan.ts test/dates.test.ts test/plan.test.ts
git commit -m "Add project scaffold and reading plan model" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Mistborn plan, plan registry, schedule script

**Files:**
- Create: `plans/mistborn.ts`, `plans/index.ts`, `scripts/schedule.ts`
- Test: `test/mistborn.test.ts`

**Interfaces:**
- Consumes: `Plan`, `expandUnits`, `validatePlan`, `buildSchedule` from `src/plan.ts`.
- Produces: `PLANS: Record<string, Plan>` (`plans/index.ts`), default export `Plan` (`plans/mistborn.ts`).

- [ ] **Step 1: Write the failing test — `test/mistborn.test.ts`**

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/mistborn.test.ts`
Expected: FAIL — cannot resolve `../plans/mistborn.ts`.

- [ ] **Step 3: Create `plans/mistborn.ts`**

```ts
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
```

- [ ] **Step 4: Create `plans/index.ts`**

```ts
import type { Plan } from "../src/plan.ts";
import mistborn from "./mistborn.ts";

/** Plans selectable via the PLAN var. Register new plans here. */
export const PLANS: Record<string, Plan> = { mistborn };
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/mistborn.test.ts`
Expected: PASS.

- [ ] **Step 6: Create `scripts/schedule.ts`**

```ts
// Prints a plan's computed schedule: npm run schedule <plan>
import { PLANS } from "../plans/index.ts";
import { buildSchedule, validatePlan } from "../src/plan.ts";

const name = process.argv[2] ?? "";
const plan = Object.hasOwn(PLANS, name) ? PLANS[name] : undefined;

if (!plan) {
    console.error(
        `Usage: npm run schedule <plan>  (plans: ${Object.keys(PLANS).join(", ")})`,
    );
    process.exitCode = 1;
} else {
    const errors = validatePlan(plan);
    if (errors.length > 0) {
        console.error(`Plan "${name}" is invalid:\n- ${errors.join("\n- ")}`);
        process.exitCode = 1;
    } else {
        for (const s of buildSchedule(plan)) {
            console.log(
                `#${String(s.n).padEnd(3)} ${s.date}  ${s.book.short.padEnd(4)} ${s.range}`,
            );
        }
    }
}
```

- [ ] **Step 7: Run the script**

Run: `npm run schedule mistborn`
Expected: 55 lines; first `#1   2026-10-18  TFE  Prologue–Ch 3`; last `#55  2028-11-12  TLM  Ch 71–74 + Epilogues 1–7`.
Run: `npm run schedule nope` — Expected: usage message listing `mistborn`, non-zero exit.

- [ ] **Step 8: Typecheck and commit**

Run: `npx tsc --noEmit` — Expected: exit 0.

```bash
git add plans scripts test/mistborn.test.ts
git commit -m "Add Mistborn reading plan and schedule script" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Due logic (local time, DST, missed runs, reminders)

**Files:**
- Create: `src/due.ts`
- Test: `test/due.test.ts`

**Interfaces:**
- Consumes: `addDays` (`src/dates.ts`), `Session` (`src/plan.ts`).
- Produces:
  - `interface LocalNow { today: string; hour: number }`
  - `interface Timing { postHour: number; postOffsetDays: number; reminderDaysBefore: number }`
  - `localNow(instant: number, timeZone: string): LocalNow`
  - `isDue(date: string, now: LocalNow, postHour: number): boolean`
  - `postDate(session: Session, offsetDays: number): string`
  - `pickThreadSession(sessions: Session[], now: LocalNow, timing: Timing): Session | undefined`
  - `skippedSessions(sessions: Session[], lastPostedN: number, target: Session): Session[]`
  - `pickReminder(sessions: Session[], now: LocalNow, timing: Timing): Session | undefined`

- [ ] **Step 1: Write the failing test — `test/due.test.ts`**

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/due.test.ts`
Expected: FAIL — cannot resolve `../src/due.ts`.

- [ ] **Step 3: Implement `src/due.ts`**

```ts
import { addDays } from "./dates.ts";
import type { Session } from "./plan.ts";

export interface LocalNow {
    today: string;
    hour: number;
}

export interface Timing {
    postHour: number;
    postOffsetDays: number;
    reminderDaysBefore: number;
}

/** Local calendar date and hour (0-23) of `instant` in `timeZone`. */
export function localNow(instant: number, timeZone: string): LocalNow {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            hourCycle: "h23",
        })
            .formatToParts(new Date(instant))
            .map((p) => [p.type, p.value]),
    );
    return {
        today: `${parts.year}-${parts.month}-${parts.day}`,
        hour: Number(parts.hour),
    };
}

/**
 * True once `date` has arrived locally and the post hour has passed.
 * Hourly checks of local time make DST safe: a skipped hour is caught
 * by the next run's `>=`, and a repeated hour is harmless.
 */
export function isDue(date: string, now: LocalNow, postHour: number): boolean {
    return date < now.today || (date === now.today && now.hour >= postHour);
}

export function postDate(session: Session, offsetDays: number): string {
    return addDays(session.date, offsetDays);
}

/** The most recent session whose post time has passed. */
export function pickThreadSession(
    sessions: Session[],
    now: LocalNow,
    timing: Timing,
): Session | undefined {
    return sessions
        .filter((s) => isDue(postDate(s, timing.postOffsetDays), now, timing.postHour))
        .at(-1);
}

/** Sessions after the last posted one and before `target`: never backfilled. */
export function skippedSessions(
    sessions: Session[],
    lastPostedN: number,
    target: Session,
): Session[] {
    return sessions.filter((s) => s.n > lastPostedN && s.n < target.n);
}

/** The upcoming session whose reminder is due, if any. */
export function pickReminder(
    sessions: Session[],
    now: LocalNow,
    timing: Timing,
): Session | undefined {
    if (timing.reminderDaysBefore === 0) return undefined;
    const next = sessions.find(
        (s) => !isDue(postDate(s, timing.postOffsetDays), now, timing.postHour),
    );
    if (!next) return undefined;
    const remindOn = addDays(
        postDate(next, timing.postOffsetDays),
        -timing.reminderDaysBefore,
    );
    return isDue(remindOn, now, timing.postHour) ? next : undefined;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/due.test.ts && npx tsc --noEmit`
Expected: PASS; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/due.ts test/due.test.ts
git commit -m "Add due-session and reminder selection in local time" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Template rendering

**Files:**
- Create: `src/render.ts`, `test/fixtures.ts`
- Test: `test/render.test.ts`

**Interfaces:**
- Consumes: `Session`, `Plan`, `buildSchedule` (`src/plan.ts`).
- Produces:
  - `interface Templates { threadTitle: string; opening: string; next: string; finalText: string; reminder: string }`
  - `DEFAULT_TEMPLATES: Templates`
  - `interface RenderOptions { templates: Templates; spoilerPolicy: string; roleId?: string }`
  - `interface RenderedPost { title: string; content: string }`
  - `templateErrors(templates: Templates): string[]` — messages formatted `${key}: unknown or disallowed placeholder {${name}}`
  - `renderPost(opts: RenderOptions, sessions: Session[], session: Session): RenderedPost` (throws `RangeError` if content > 2000 chars)
  - `renderReminder(templates: Templates, next: Session): string`
  - `TINY_PLAN: Plan` (`test/fixtures.ts`)

- [ ] **Step 1: Create `test/fixtures.ts`**

```ts
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
```

- [ ] **Step 2: Write the failing test — `test/render.test.ts`**

```ts
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
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/render.test.ts`
Expected: FAIL — cannot resolve `../src/render.ts`.

- [ ] **Step 4: Implement `src/render.ts`**

```ts
import type { Session } from "./plan.ts";

export interface Templates {
    threadTitle: string;
    opening: string;
    next: string;
    finalText: string;
    reminder: string;
}

export const DEFAULT_TEMPLATES: Templates = {
    threadTitle: "{bookShort} · Session {n} · {range}",
    opening:
        "**{bookTitle} — {range}**\nSession {n} of {total} · {date}\n\n{spoilerPolicy}\n\n{next}",
    next: "📖 **Read next:** {nextBookTitle}, {nextRange} — discussion opens {nextDate}.",
    finalText: "🎉 That's the end of the read. Thanks for reading along!",
    reminder:
        "⏰ **Reminder:** next discussion opens {nextDate} — {nextBookTitle}, {nextRange}.",
};

export interface RenderOptions {
    templates: Templates;
    spoilerPolicy: string;
    roleId?: string;
}

export interface RenderedPost {
    title: string;
    content: string;
}

const MAX_TITLE = 100;
const MAX_CONTENT = 2000;
const PLACEHOLDER = /\{(\w+)\}/g;

const CURRENT = ["bookTitle", "bookShort", "n", "total", "range", "date"];
const NEXT = ["nextBookTitle", "nextBookShort", "nextRange", "nextDate"];
const ALLOWED: Record<keyof Templates, string[]> = {
    threadTitle: CURRENT,
    opening: [...CURRENT, "spoilerPolicy", "next"],
    next: NEXT,
    finalText: [],
    reminder: NEXT,
};

/** Problems with placeholders used in each template; empty means valid. */
export function templateErrors(templates: Templates): string[] {
    return (Object.keys(ALLOWED) as (keyof Templates)[]).flatMap((key) =>
        [...templates[key].matchAll(PLACEHOLDER)]
            .map((m) => m[1])
            .filter((name) => !ALLOWED[key].includes(name))
            .map((name) => `${key}: unknown or disallowed placeholder {${name}}`),
    );
}

function fill(template: string, values: Record<string, string>): string {
    return template.replace(PLACEHOLDER, (match, key: string) => values[key] ?? match);
}

/** "2027-01-03" → "Sunday, January 3, 2027" (the date itself, no zone shift). */
function formatDate(date: string): string {
    return new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
    }).format(new Date(`${date}T00:00:00Z`));
}

function currentValues(session: Session, total: number): Record<string, string> {
    return {
        bookTitle: session.book.title,
        bookShort: session.book.short,
        n: String(session.n),
        total: String(total),
        range: session.range,
        date: formatDate(session.date),
    };
}

function nextValues(next: Session): Record<string, string> {
    return {
        nextBookTitle: next.book.title,
        nextBookShort: next.book.short,
        nextRange: next.range,
        nextDate: formatDate(next.date),
    };
}

/** Collapses runs of blank lines left by empty placeholders. */
function tidy(text: string): string {
    return text.replace(/\n{3,}/g, "\n\n").trim();
}

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Thread title and opening message for `session`. */
export function renderPost(
    opts: RenderOptions,
    sessions: Session[],
    session: Session,
): RenderedPost {
    const { templates } = opts;
    const current = currentValues(session, sessions.length);
    const next = sessions.find((s) => s.n === session.n + 1);
    const body = tidy(
        fill(templates.opening, {
            ...current,
            spoilerPolicy: opts.spoilerPolicy,
            next: next ? fill(templates.next, nextValues(next)) : templates.finalText,
        }),
    );
    const content = opts.roleId ? `<@&${opts.roleId}>\n${body}` : body;
    if (content.length > MAX_CONTENT) {
        throw new RangeError(
            `Opening message for session ${session.n} is ${content.length} characters (max ${MAX_CONTENT})`,
        );
    }
    return { title: truncate(fill(templates.threadTitle, current), MAX_TITLE), content };
}

/** Reminder text announcing `next`. */
export function renderReminder(templates: Templates, next: Session): string {
    return tidy(fill(templates.reminder, nextValues(next)));
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/render.test.ts && npx tsc --noEmit`
Expected: PASS; tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/render.ts test/render.test.ts test/fixtures.ts
git commit -m "Add thread and reminder template rendering" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Config parsing and validation

**Files:**
- Create: `src/config.ts`
- Modify: `test/fixtures.ts` (append `IDS`, `PLANS`, `MemoryKV`, `baseEnv`, `kvOf`)
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `Plan`, `Session`, `validatePlan`, `buildSchedule` (`src/plan.ts`); `Templates`, `DEFAULT_TEMPLATES`, `templateErrors` (`src/render.ts`).
- Produces:
  - `type ChannelMode = "forum" | "text"`
  - `interface Env { STATE: KVNamespace; [name: string]: unknown }`
  - `interface Config` with fields: `plan: Plan; sessions: Session[]; guildId: string; channelId: string; channelMode: ChannelMode; timezone: string; postHour: number; postOffsetDays: number; roleId?: string; forumTags: Record<string, string>; lockPrevious: boolean; reminderDaysBefore: number; dryRun: boolean; testChannelId?: string; testChannelMode: ChannelMode; spoilerPolicy: string; templates: Templates; token?: string`. (Structurally satisfies `Timing` and `RenderOptions`.)
  - `class ConfigError extends Error { readonly problems: string[] }`
  - `parseConfig(env: Env, plans: Record<string, Plan>): Config` (throws `ConfigError`)
  - Fixtures: `IDS`, `PLANS`, `MemoryKV`, `baseEnv(vars?)`, `kvOf(env)`

- [ ] **Step 1: Append to `test/fixtures.ts`**

Add `import type { Env } from "../src/config.ts";` to the imports, then append:

```ts
export const IDS = {
    guild: "100000000000000001",
    channel: "100000000000000002",
    testChannel: "100000000000000003",
    role: "100000000000000009",
    tag: "200000000000000001",
};

export const PLANS: Record<string, Plan> = { tiny: TINY_PLAN };

/** In-memory stand-in for the subset of KVNamespace the bot uses. */
export class MemoryKV {
    readonly data = new Map<string, string>();

    async get(key: string, type?: "json"): Promise<unknown> {
        const value = this.data.get(key);
        if (value === undefined) return null;
        return type === "json" ? JSON.parse(value) : value;
    }

    async put(key: string, value: string): Promise<void> {
        this.data.set(key, value);
    }

    async delete(key: string): Promise<void> {
        this.data.delete(key);
    }
}

/** A valid forum-mode env for the tiny plan; `vars` override or add vars. */
export function baseEnv(vars: Record<string, unknown> = {}): Env {
    return {
        STATE: new MemoryKV() as unknown as KVNamespace,
        PLAN: "tiny",
        GUILD_ID: IDS.guild,
        CHANNEL_ID: IDS.channel,
        CHANNEL_MODE: "forum",
        DISCORD_BOT_TOKEN: "test-token",
        ...vars,
    };
}

export function kvOf(env: Env): MemoryKV {
    return env.STATE as unknown as MemoryKV;
}
```

- [ ] **Step 2: Write the failing test — `test/config.test.ts`**

```ts
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
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.ts`.

- [ ] **Step 4: Implement `src/config.ts`**

```ts
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
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/config.test.ts && npx tsc --noEmit`
Expected: PASS; tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/config.test.ts test/fixtures.ts
git commit -m "Add typed config parsing and validation" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Discord REST client

**Files:**
- Create: `src/discord.ts`
- Test: `test/discord.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ForumPost { name: string; content: string; tagIds: string[]; roleId?: string }`
  - `interface DiscordApi { createForumPost(channelId: string, post: ForumPost): Promise<string>; createThread(channelId: string, name: string): Promise<string>; sendMessage(channelId: string, content: string, roleId?: string): Promise<string>; archiveThread(threadId: string, locked: boolean): Promise<void>; deleteChannel(channelId: string): Promise<void> }` — create/send methods return the new thread/message ID.
  - `class DiscordHttpError extends Error { method; path; status; code?; errors? }`
  - `class DiscordNetworkError extends Error { method; path }`
  - `class DiscordClient implements DiscordApi` — `constructor(token: string, fetchFn?: Fetch, sleep?: Sleep)` where `type Fetch = (url: string, init: RequestInit) => Promise<Response>`, `type Sleep = (ms: number) => Promise<void>`.

- [ ] **Step 1: Write the failing test — `test/discord.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
    DiscordClient,
    DiscordHttpError,
    DiscordNetworkError,
} from "../src/discord.ts";

interface Captured {
    url: string;
    method: string;
    headers: Headers;
    body: unknown;
}

const json = (body: unknown, status = 200) => () =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });

function setup(responses: (() => Response)[]) {
    const requests: Captured[] = [];
    const sleeps: number[] = [];
    const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
        requests.push({
            url,
            method: init.method ?? "GET",
            headers: new Headers(init.headers),
            body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        const next = responses.shift();
        if (!next) throw new Error("unexpected request");
        return next();
    };
    const client = new DiscordClient("tok", fetchFn, async (ms) => {
        sleeps.push(ms);
    });
    return { client, requests, sleeps };
}

describe("DiscordClient", () => {
    it("creates a forum post with tags and safe mentions", async () => {
        const { client, requests } = setup([json({ id: "555" })]);
        await expect(
            client.createForumPost("123", { name: "T", content: "Hi", tagIds: ["9"] }),
        ).resolves.toBe("555");
        const [req] = requests;
        expect(req.url).toBe("https://discord.com/api/v10/channels/123/threads");
        expect(req.method).toBe("POST");
        expect(req.headers.get("Authorization")).toBe("Bot tok");
        expect(req.headers.get("User-Agent")).toMatch(/^DiscordBot \(/);
        expect(req.body).toEqual({
            name: "T",
            auto_archive_duration: 10080,
            message: { content: "Hi", allowed_mentions: { parse: [] } },
            applied_tags: ["9"],
        });
    });

    it("omits tags when there are none and allows only the pinged role", async () => {
        const { client, requests } = setup([json({ id: "555" })]);
        await client.createForumPost("123", { name: "T", content: "Hi", tagIds: [], roleId: "77" });
        expect(requests[0].body).toEqual({
            name: "T",
            auto_archive_duration: 10080,
            message: { content: "Hi", allowed_mentions: { parse: [], roles: ["77"] } },
        });
    });

    it("creates a public thread", async () => {
        const { client, requests } = setup([json({ id: "556" })]);
        await expect(client.createThread("123", "T")).resolves.toBe("556");
        expect(requests[0].body).toEqual({ name: "T", type: 11, auto_archive_duration: 10080 });
    });

    it("sends a message", async () => {
        const { client, requests } = setup([json({ id: "777" })]);
        await expect(client.sendMessage("42", "hello")).resolves.toBe("777");
        expect(requests[0].url).toBe("https://discord.com/api/v10/channels/42/messages");
        expect(requests[0].body).toEqual({ content: "hello", allowed_mentions: { parse: [] } });
    });

    it("archives and locks a thread", async () => {
        const { client, requests } = setup([json({ id: "42" })]);
        await client.archiveThread("42", true);
        expect(requests[0].method).toBe("PATCH");
        expect(requests[0].body).toEqual({ archived: true, locked: true });
    });

    it("deletes a channel, accepting 204", async () => {
        const { client, requests } = setup([() => new Response(null, { status: 204 })]);
        await expect(client.deleteChannel("42")).resolves.toBeUndefined();
        expect(requests[0].method).toBe("DELETE");
    });

    it("waits retry_after on 429 and retries", async () => {
        const { client, requests, sleeps } = setup([
            json({ message: "rate limited", retry_after: 1.5, global: false }, 429),
            json({ id: "1" }),
        ]);
        await expect(client.sendMessage("42", "x")).resolves.toBe("1");
        expect(sleeps).toEqual([1500]);
        expect(requests).toHaveLength(2);
    });

    it("falls back to Retry-After, then to 1 second", async () => {
        const { client, sleeps } = setup([
            () => new Response("", { status: 429, headers: { "Retry-After": "2" } }),
            () => new Response("", { status: 429 }),
            json({ id: "1" }),
        ]);
        await client.sendMessage("42", "x");
        expect(sleeps).toEqual([2000, 1000]);
    });

    it("gives up after 3 retries", async () => {
        const limited = json({ retry_after: 0.1 }, 429);
        const { client, requests, sleeps } = setup([limited, limited, limited, limited]);
        const err = await client.sendMessage("42", "x").catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DiscordHttpError);
        expect(err).toMatchObject({ status: 429 });
        expect(requests).toHaveLength(4);
        expect(sleeps).toHaveLength(3);
    });

    it("raises DiscordHttpError with Discord's error details", async () => {
        const { client } = setup([
            json({ code: 50013, message: "Missing Permissions", errors: { a: 1 } }, 403),
        ]);
        const err = await client.sendMessage("1", "x").catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DiscordHttpError);
        expect(err).toMatchObject({
            method: "POST",
            path: "/channels/1/messages",
            status: 403,
            code: 50013,
            errors: { a: 1 },
        });
        expect((err as Error).message).toContain("Missing Permissions");
    });

    it("raises DiscordNetworkError when the request does not complete", async () => {
        const { client } = setup([
            () => {
                throw new TypeError("network down");
            },
        ]);
        await expect(client.sendMessage("1", "x")).rejects.toBeInstanceOf(DiscordNetworkError);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/discord.test.ts`
Expected: FAIL — cannot resolve `../src/discord.ts`.

- [ ] **Step 3: Implement `src/discord.ts`**

```ts
const API = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (reread-bot, 1)";
const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const ARCHIVE_AFTER_MINUTES = 10080; // 7 days, Discord's maximum

export interface ForumPost {
    name: string;
    content: string;
    tagIds: string[];
    roleId?: string;
}

/** The Discord operations the bot needs; faked in tests. */
export interface DiscordApi {
    /** Creates a forum post; returns the thread ID. */
    createForumPost(channelId: string, post: ForumPost): Promise<string>;
    /** Creates an empty public thread in a text channel; returns its ID. */
    createThread(channelId: string, name: string): Promise<string>;
    /** Posts a message; returns the message ID. */
    sendMessage(channelId: string, content: string, roleId?: string): Promise<string>;
    archiveThread(threadId: string, locked: boolean): Promise<void>;
    deleteChannel(channelId: string): Promise<void>;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Sleep = (ms: number) => Promise<void>;

interface ErrorBody {
    code?: number;
    message?: string;
    errors?: unknown;
}

/** Discord answered with an error status: the action definitely did not happen. */
export class DiscordHttpError extends Error {
    readonly method: string;
    readonly path: string;
    readonly status: number;
    readonly code?: number;
    readonly errors?: unknown;

    constructor(method: string, path: string, status: number, body: ErrorBody) {
        super(`Discord ${method} ${path} → ${status}${body.message ? `: ${body.message}` : ""}`);
        this.name = "DiscordHttpError";
        this.method = method;
        this.path = path;
        this.status = status;
        this.code = body.code;
        this.errors = body.errors;
    }
}

/** No answer (network failure or timeout): the action may or may not have happened. */
export class DiscordNetworkError extends Error {
    readonly method: string;
    readonly path: string;

    constructor(method: string, path: string, cause: unknown) {
        super(`Discord ${method} ${path} did not complete: ${String(cause)}`, { cause });
        this.name = "DiscordNetworkError";
        this.method = method;
        this.path = path;
    }
}

function mentions(roleId?: string): { parse: string[]; roles?: string[] } {
    return roleId ? { parse: [], roles: [roleId] } : { parse: [] };
}

async function retryAfterMs(res: Response): Promise<number> {
    const body = (await res.json().catch(() => ({}))) as { retry_after?: unknown };
    const seconds =
        typeof body.retry_after === "number"
            ? body.retry_after
            : Number(res.headers.get("Retry-After"));
    return Math.ceil((Number.isFinite(seconds) && seconds > 0 ? seconds : 1) * 1000);
}

async function errorBody(res: Response): Promise<ErrorBody> {
    const text = await res.text();
    try {
        return JSON.parse(text) as ErrorBody;
    } catch {
        return { message: text.slice(0, 200) };
    }
}

export class DiscordClient implements DiscordApi {
    private readonly token: string;
    private readonly fetchFn: Fetch;
    private readonly sleep: Sleep;

    constructor(
        token: string,
        // Wrapped: Workers throws "Illegal invocation" if fetch is called as a method.
        fetchFn: Fetch = (url, init) => fetch(url, init),
        sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ) {
        this.token = token;
        this.fetchFn = fetchFn;
        this.sleep = sleep;
    }

    async createForumPost(channelId: string, post: ForumPost): Promise<string> {
        const thread = await this.request<{ id: string }>("POST", `/channels/${channelId}/threads`, {
            name: post.name,
            auto_archive_duration: ARCHIVE_AFTER_MINUTES,
            message: { content: post.content, allowed_mentions: mentions(post.roleId) },
            ...(post.tagIds.length > 0 ? { applied_tags: post.tagIds } : {}),
        });
        return thread.id;
    }

    async createThread(channelId: string, name: string): Promise<string> {
        const thread = await this.request<{ id: string }>("POST", `/channels/${channelId}/threads`, {
            name,
            type: 11, // PUBLIC_THREAD
            auto_archive_duration: ARCHIVE_AFTER_MINUTES,
        });
        return thread.id;
    }

    async sendMessage(channelId: string, content: string, roleId?: string): Promise<string> {
        const message = await this.request<{ id: string }>("POST", `/channels/${channelId}/messages`, {
            content,
            allowed_mentions: mentions(roleId),
        });
        return message.id;
    }

    async archiveThread(threadId: string, locked: boolean): Promise<void> {
        await this.request("PATCH", `/channels/${threadId}`, { archived: true, locked });
    }

    async deleteChannel(channelId: string): Promise<void> {
        await this.request("DELETE", `/channels/${channelId}`);
    }

    private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        for (let attempt = 0; ; attempt++) {
            let res: Response;
            try {
                res = await this.fetchFn(`${API}${path}`, {
                    method,
                    headers: {
                        Authorization: `Bot ${this.token}`,
                        "Content-Type": "application/json",
                        "User-Agent": USER_AGENT,
                    },
                    body: body === undefined ? undefined : JSON.stringify(body),
                    signal: AbortSignal.timeout(TIMEOUT_MS),
                });
            } catch (cause) {
                throw new DiscordNetworkError(method, path, cause);
            }
            if (res.status === 429 && attempt < MAX_RETRIES) {
                await this.sleep(await retryAfterMs(res));
                continue;
            }
            if (!res.ok) throw new DiscordHttpError(method, path, res.status, await errorBody(res));
            return (res.status === 204 ? undefined : await res.json()) as T;
        }
    }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/discord.test.ts && npx tsc --noEmit`
Expected: PASS; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/discord.ts test/discord.test.ts
git commit -m "Add Discord REST client with rate-limit handling" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Scheduled run orchestration

**Files:**
- Create: `src/run.ts`
- Modify: `test/fixtures.ts` (append `FakeDiscord`)
- Test: `test/run.test.ts`

**Interfaces:**
- Consumes: `Config`, `ChannelMode` (`src/config.ts`); `DiscordApi`, `DiscordHttpError` (`src/discord.ts`); `localNow`, `pickThreadSession`, `pickReminder`, `skippedSessions`, `LocalNow` (`src/due.ts`); `Session` (`src/plan.ts`); `renderPost`, `renderReminder`, `RenderedPost` (`src/render.ts`).
- Produces:
  - `interface SessionRecord { status: "pending" | "posted"; threadId?: string; startedAt: string; postedAt?: string }`
  - `interface LatestRecord { n: number; threadId: string }`
  - `runScheduled(cfg: Config, kv: KVNamespace, discord: DiscordApi, instant: number): Promise<void>` (throws `AggregateError` whose message includes every step failure)
  - `createSessionThread(discord: DiscordApi, channelId: string, mode: ChannelMode, post: RenderedPost, tagIds: string[], roleId?: string): Promise<string>`
  - KV keys: `session:{n}`, `latest`, `reminder:{n}`
  - Fixture `FakeDiscord implements DiscordApi` with `calls: {method, args}[]`, `failures: Map<string, Error>`; IDs `thread-1`, `thread-2`, … and `message-1`, …

- [ ] **Step 1: Append `FakeDiscord` to `test/fixtures.ts`**

Add `import type { DiscordApi, ForumPost } from "../src/discord.ts";` to the imports, then append:

```ts
/** Records calls; a method listed in `failures` throws that error (after recording). */
export class FakeDiscord implements DiscordApi {
    readonly calls: { method: string; args: unknown[] }[] = [];
    readonly failures = new Map<string, Error>();
    private threads = 0;
    private messages = 0;

    private record(method: string, args: unknown[]): void {
        this.calls.push({ method, args });
        const failure = this.failures.get(method);
        if (failure) throw failure;
    }

    async createForumPost(channelId: string, post: ForumPost): Promise<string> {
        this.record("createForumPost", [channelId, post]);
        return `thread-${++this.threads}`;
    }

    async createThread(channelId: string, name: string): Promise<string> {
        this.record("createThread", [channelId, name]);
        return `thread-${++this.threads}`;
    }

    async sendMessage(channelId: string, content: string, roleId?: string): Promise<string> {
        this.record("sendMessage", [channelId, content, roleId]);
        return `message-${++this.messages}`;
    }

    async archiveThread(threadId: string, locked: boolean): Promise<void> {
        this.record("archiveThread", [threadId, locked]);
    }

    async deleteChannel(channelId: string): Promise<void> {
        this.record("deleteChannel", [channelId]);
    }
}
```

- [ ] **Step 2: Write the failing test — `test/run.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.ts";
import { DiscordHttpError, DiscordNetworkError } from "../src/discord.ts";
import { runScheduled } from "../src/run.ts";
import { baseEnv, FakeDiscord, IDS, kvOf, PLANS } from "./fixtures.ts";

// Tiny plan sessions post at 09:00 Los Angeles = 17:00Z in January 2027.
const DAY1 = Date.parse("2027-01-03T17:00:00Z");
const DAY2 = Date.parse("2027-01-10T17:00:00Z");
const DAY3 = Date.parse("2027-01-17T17:00:00Z");
const REMIND2 = Date.parse("2027-01-07T17:00:00Z");
const HOUR = 3_600_000;

function setup(vars: Record<string, unknown> = {}) {
    const env = baseEnv(vars);
    const cfg = parseConfig(env, PLANS);
    const discord = new FakeDiscord();
    const run = (instant: number) => runScheduled(cfg, env.STATE, discord, instant);
    return { discord, kv: kvOf(env), run };
}

const methods = (d: FakeDiscord) => d.calls.map((c) => c.method);
const record = (kv: ReturnType<typeof kvOf>, key: string) =>
    JSON.parse(kv.data.get(key) ?? "null");

beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("thread step", () => {
    it("does nothing before the first session is due", async () => {
        const { discord, kv, run } = setup();
        await run(DAY1 - HOUR);
        expect(discord.calls).toEqual([]);
        expect(kv.data.size).toBe(0);
    });

    it("opens the due session once and records it", async () => {
        const { discord, kv, run } = setup();
        await run(DAY1);
        await run(DAY1 + HOUR);
        expect(discord.calls).toEqual([
            {
                method: "createForumPost",
                args: [
                    IDS.channel,
                    {
                        name: "AAA · Session 1 · Prologue–Ch 2",
                        content: expect.stringContaining("Session 1 of 3"),
                        tagIds: [],
                        roleId: undefined,
                    },
                ],
            },
        ]);
        expect(record(kv, "session:1")).toMatchObject({ status: "posted", threadId: "thread-1" });
        expect(record(kv, "latest")).toEqual({ n: 1, threadId: "thread-1" });
    });

    it("posts only the most recent due session after missed runs", async () => {
        const { discord, run } = setup();
        await run(DAY3);
        expect(methods(discord)).toEqual(["createForumPost"]);
        expect(discord.calls[0].args[1]).toMatchObject({ name: "BBB · Session 3 · Ch 1–3" });
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Session 1 "));
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Session 2 "));
    });

    it("is a silent no-op after the final session", async () => {
        const { discord, run } = setup();
        await run(DAY3);
        const later = Date.parse("2030-06-01T17:00:00Z");
        await run(later);
        await run(later + HOUR);
        expect(methods(discord)).toEqual(["createForumPost"]);
        expect(console.error).not.toHaveBeenCalled();
    });

    it("locks the previous thread when the next session opens", async () => {
        const { discord, run } = setup();
        await run(DAY1);
        await run(DAY2);
        expect(discord.calls.at(-1)).toEqual({ method: "archiveThread", args: ["thread-1", true] });
    });

    it("leaves the previous thread open when LOCK_PREVIOUS is false", async () => {
        const { discord, run } = setup({ LOCK_PREVIOUS: "false" });
        await run(DAY1);
        await run(DAY2);
        expect(methods(discord)).toEqual(["createForumPost", "createForumPost"]);
    });

    it("pings the role and applies the book's forum tag", async () => {
        const { discord, run } = setup({
            ROLE_ID: IDS.role,
            FORUM_TAGS: JSON.stringify({ AAA: IDS.tag }),
        });
        await run(DAY1);
        expect(discord.calls[0].args[1]).toMatchObject({
            tagIds: [IDS.tag],
            roleId: IDS.role,
            content: expect.stringMatching(new RegExp(`^<@&${IDS.role}>\n`)),
        });
    });

    it("releases the pending marker when Discord rejects the post", async () => {
        const { discord, kv, run } = setup();
        discord.failures.set("createForumPost", new DiscordHttpError("POST", "/x", 500, {}));
        await expect(run(DAY1)).rejects.toThrow();
        expect(kv.data.has("session:1")).toBe(false);
        discord.failures.clear();
        await run(DAY1 + HOUR);
        expect(record(kv, "session:1")).toMatchObject({ status: "posted" });
    });

    it("keeps the pending marker and stops retrying after an ambiguous failure", async () => {
        const { discord, kv, run } = setup();
        discord.failures.set(
            "createForumPost",
            new DiscordNetworkError("POST", "/x", new Error("timeout")),
        );
        await expect(run(DAY1)).rejects.toThrow();
        expect(record(kv, "session:1")).toMatchObject({ status: "pending" });
        discord.failures.clear();
        await expect(run(DAY1 + HOUR)).rejects.toThrow(/stuck pending/);
        expect(methods(discord)).toEqual(["createForumPost"]);
    });

    it("dry run reads state but never calls Discord or writes KV", async () => {
        const { discord, kv, run } = setup({ DRY_RUN: "true", DISCORD_BOT_TOKEN: "" });
        await run(DAY1);
        await run(REMIND2);
        expect(discord.calls).toEqual([]);
        expect(kv.data.size).toBe(0);
        expect(console.log).toHaveBeenCalledWith(
            expect.stringContaining("[dry-run] would open session 1"),
            expect.anything(),
        );
    });
});

describe("thread step in text mode", () => {
    it("creates a thread, then posts the opening message", async () => {
        const { discord, run } = setup({ CHANNEL_MODE: "text", ROLE_ID: IDS.role });
        await run(DAY1);
        expect(methods(discord)).toEqual(["createThread", "sendMessage"]);
        expect(discord.calls[1].args).toEqual([
            "thread-1",
            expect.stringContaining("Session 1 of 3"),
            IDS.role,
        ]);
    });

    it("deletes the empty thread if the opening message is rejected", async () => {
        const { discord, kv, run } = setup({ CHANNEL_MODE: "text" });
        discord.failures.set("sendMessage", new DiscordHttpError("POST", "/x", 403, {}));
        await expect(run(DAY1)).rejects.toThrow();
        expect(methods(discord)).toEqual(["createThread", "sendMessage", "deleteChannel"]);
        expect(kv.data.has("session:1")).toBe(false);
    });

    it("records the thread if it cannot be deleted", async () => {
        const { discord, kv, run } = setup({ CHANNEL_MODE: "text" });
        discord.failures.set("sendMessage", new DiscordHttpError("POST", "/x", 403, {}));
        discord.failures.set("deleteChannel", new DiscordHttpError("DELETE", "/x", 403, {}));
        await expect(run(DAY1)).rejects.toThrow();
        expect(record(kv, "session:1")).toMatchObject({ status: "posted", threadId: "thread-1" });
    });
});

describe("reminder step", () => {
    it("posts one reminder in the current thread before the next session", async () => {
        const { discord, kv, run } = setup();
        await run(DAY1);
        await run(REMIND2);
        await run(REMIND2 + HOUR);
        expect(discord.calls.slice(1)).toEqual([
            {
                method: "sendMessage",
                args: ["thread-1", expect.stringContaining("**Reminder:**"), undefined],
            },
        ]);
        expect(record(kv, "reminder:2")).toMatchObject({ messageId: "message-1" });
    });

    it("sends no reminder before the first thread exists", async () => {
        const { discord, run } = setup();
        await run(Date.parse("2026-12-31T17:00:00Z"));
        expect(discord.calls).toEqual([]);
    });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/run.test.ts`
Expected: FAIL — cannot resolve `../src/run.ts`.

- [ ] **Step 4: Implement `src/run.ts`**

```ts
import type { ChannelMode, Config } from "./config.ts";
import { DiscordHttpError, type DiscordApi } from "./discord.ts";
import {
    localNow,
    pickReminder,
    pickThreadSession,
    skippedSessions,
    type LocalNow,
} from "./due.ts";
import type { Session } from "./plan.ts";
import { renderPost, renderReminder, type RenderedPost } from "./render.ts";

export interface SessionRecord {
    status: "pending" | "posted";
    threadId?: string;
    startedAt: string;
    postedAt?: string;
}

export interface LatestRecord {
    n: number;
    threadId: string;
}

type Step = (cfg: Config, kv: KVNamespace, discord: DiscordApi, now: LocalNow) => Promise<void>;

/** One hourly run: open the due session's thread, then post any due reminder. */
export async function runScheduled(
    cfg: Config,
    kv: KVNamespace,
    discord: DiscordApi,
    instant: number,
): Promise<void> {
    const now = localNow(instant, cfg.timezone);
    const steps: [string, Step][] = [
        ["thread", threadStep],
        ["reminder", reminderStep],
    ];
    const failures: unknown[] = [];
    for (const [name, step] of steps) {
        try {
            await step(cfg, kv, discord, now);
        } catch (err) {
            logError(`${name} step failed`, err);
            failures.push(err);
        }
    }
    if (failures.length > 0) {
        throw new AggregateError(
            failures,
            `Scheduled run failed: ${failures.map(String).join("; ")}`,
        );
    }
}

/** Creates the thread (forum: with its opening message). Returns the thread ID. */
export function createSessionThread(
    discord: DiscordApi,
    channelId: string,
    mode: ChannelMode,
    post: RenderedPost,
    tagIds: string[],
    roleId?: string,
): Promise<string> {
    return mode === "forum"
        ? discord.createForumPost(channelId, {
              name: post.title,
              content: post.content,
              tagIds,
              roleId,
          })
        : discord.createThread(channelId, post.title);
}

async function threadStep(
    cfg: Config,
    kv: KVNamespace,
    discord: DiscordApi,
    now: LocalNow,
): Promise<void> {
    const target = pickThreadSession(cfg.sessions, now, cfg);
    if (!target) return;
    const key = `session:${target.n}`;
    const existing = await kv.get<SessionRecord>(key, "json");
    if (existing?.status === "posted") return;
    if (existing?.status === "pending") {
        throw new Error(
            `Session ${target.n} is stuck pending since ${existing.startedAt}; ` +
                `check Discord, then fix KV key "${key}" (see README)`,
        );
    }

    const latest = await kv.get<LatestRecord>("latest", "json");
    for (const s of skippedSessions(cfg.sessions, latest?.n ?? 0, target)) {
        console.warn(`Session ${s.n} (${s.date}) was missed and will not be backfilled`);
    }
    const post = renderPost(cfg, cfg.sessions, target);
    if (cfg.dryRun) {
        console.log(
            `[dry-run] would open session ${target.n} in ${cfg.channelMode} channel ${cfg.channelId}`,
            post,
        );
        if (cfg.lockPrevious && latest) {
            console.log(`[dry-run] would lock thread ${latest.threadId}`);
        }
        return;
    }

    const threadId = await postSession(cfg, kv, discord, target, post);
    await kv.put("latest", JSON.stringify({ n: target.n, threadId } satisfies LatestRecord));
    console.log(
        `Opened session ${target.n}: https://discord.com/channels/${cfg.guildId}/${threadId}`,
    );
    if (cfg.lockPrevious && latest) {
        try {
            await discord.archiveThread(latest.threadId, true);
        } catch (err) {
            logError(`Could not lock session ${latest.n} thread ${latest.threadId}`, err);
        }
    }
}

/**
 * Posts a session guarded by a pending marker. HTTP errors mean nothing was
 * created, so the marker is released for a retry next hour. Ambiguous
 * failures leave it pending: a missed post beats a duplicate.
 */
async function postSession(
    cfg: Config,
    kv: KVNamespace,
    discord: DiscordApi,
    session: Session,
    post: RenderedPost,
): Promise<string> {
    const key = `session:${session.n}`;
    const startedAt = new Date().toISOString();
    const save = (record: SessionRecord) => kv.put(key, JSON.stringify(record));
    await save({ status: "pending", startedAt });

    const tag = cfg.forumTags[session.book.short];
    let threadId: string;
    try {
        threadId = await createSessionThread(
            discord,
            cfg.channelId,
            cfg.channelMode,
            post,
            tag ? [tag] : [],
            cfg.roleId,
        );
    } catch (err) {
        if (err instanceof DiscordHttpError) await kv.delete(key);
        throw err;
    }

    if (cfg.channelMode === "text") {
        try {
            await discord.sendMessage(threadId, post.content, cfg.roleId);
        } catch (err) {
            if (!(err instanceof DiscordHttpError)) {
                console.error(
                    `Session ${session.n}: thread ${threadId} created but opening message outcome unknown; ${key} left pending`,
                );
                throw err;
            }
            try {
                await discord.deleteChannel(threadId);
            } catch (deleteErr) {
                logError(
                    `Session ${session.n}: could not delete empty thread ${threadId}; recording it as posted`,
                    deleteErr,
                );
                await save({ status: "posted", threadId, startedAt, postedAt: new Date().toISOString() });
                throw err;
            }
            await kv.delete(key);
            throw err;
        }
    }

    await save({ status: "posted", threadId, startedAt, postedAt: new Date().toISOString() });
    return threadId;
}

async function reminderStep(
    cfg: Config,
    kv: KVNamespace,
    discord: DiscordApi,
    now: LocalNow,
): Promise<void> {
    const next = pickReminder(cfg.sessions, now, cfg);
    if (!next) return;
    const key = `reminder:${next.n}`;
    if ((await kv.get(key)) !== null) return;
    const latest = await kv.get<LatestRecord>("latest", "json");
    if (!latest) return;

    const content = renderReminder(cfg.templates, next);
    if (cfg.dryRun) {
        console.log(`[dry-run] would remind in thread ${latest.threadId}`, content);
        return;
    }
    const messageId = await discord.sendMessage(latest.threadId, content);
    await kv.put(key, JSON.stringify({ messageId, postedAt: new Date().toISOString() }));
}

function logError(message: string, err: unknown): void {
    console.error(
        message,
        err instanceof DiscordHttpError
            ? { error: err.message, status: err.status, code: err.code, errors: err.errors }
            : err,
    );
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/run.test.ts && npx tsc --noEmit`
Expected: PASS; tsc exit 0. (Note: the dry-run test runs at `REMIND2` with no `latest`, so the reminder step returns before its dry-run log — `kv.data.size` stays 0.)

- [ ] **Step 6: Commit**

```bash
git add src/run.ts test/run.test.ts test/fixtures.ts
git commit -m "Add hourly run orchestration with pending-marker idempotency" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Admin route and Worker entry point

**Files:**
- Create: `src/admin.ts`, `src/index.ts`
- Test: `test/admin.test.ts`

**Interfaces:**
- Consumes: `parseConfig`, `ConfigError`, `Config`, `Env` (`src/config.ts`); `DiscordClient`, `DiscordApi`, `DiscordHttpError`, `DiscordNetworkError` (`src/discord.ts`); `localNow`, `isDue`, `pickThreadSession`, `postDate` (`src/due.ts`); `Plan`, `Session` (`src/plan.ts`); `renderPost`, `renderReminder` (`src/render.ts`); `createSessionThread`, `runScheduled` (`src/run.ts`); `PLANS` (`plans/index.ts`).
- Produces:
  - `handleRequest(request: Request, env: Env, plans: Record<string, Plan>, instant: number, discord?: DiscordApi): Promise<Response>`
  - Default export `ExportedHandler<Env>` with `scheduled` and `fetch`.

- [ ] **Step 1: Write the failing test — `test/admin.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/admin.ts";
import { DiscordHttpError } from "../src/discord.ts";
import { baseEnv, FakeDiscord, IDS, kvOf, PLANS } from "./fixtures.ts";

const SECRET = "s3cret";
const BEFORE_FIRST = Date.parse("2027-01-02T17:00:00Z");

async function call(
    path: string,
    opts: { method?: string; secret?: string; vars?: Record<string, unknown>; discord?: FakeDiscord } = {},
) {
    const env = baseEnv({ ADMIN_SECRET: SECRET, TEST_CHANNEL_ID: IDS.testChannel, ...opts.vars });
    const discord = opts.discord ?? new FakeDiscord();
    const request = new Request(`https://bot.example${path}`, {
        method: opts.method ?? "GET",
        headers: { "X-Admin-Secret": opts.secret ?? SECRET },
    });
    const response = await handleRequest(request, env, PLANS, BEFORE_FIRST, discord);
    const body = response.headers.get("Content-Type")?.includes("json")
        ? await response.json<Record<string, unknown>>()
        : await response.text();
    return { status: response.status, body, discord, kv: kvOf(env) };
}

describe("admin route", () => {
    it("is 404 everywhere when ADMIN_SECRET is unset", async () => {
        expect((await call("/admin/preview", { vars: { ADMIN_SECRET: "" } })).status).toBe(404);
    });

    it("is 404 outside /admin/", async () => {
        expect((await call("/")).status).toBe(404);
    });

    it("rejects a wrong secret", async () => {
        expect((await call("/admin/preview", { secret: "wrong" })).status).toBe(401);
    });

    it("previews the next session by default", async () => {
        const { status, body } = await call("/admin/preview");
        expect(status).toBe(200);
        expect(body).toMatchObject({
            session: { n: 1 },
            postDate: "2027-01-03",
            title: "AAA · Session 1 · Prologue–Ch 2",
            reminder: expect.stringContaining("Ch 3–4 + Epilogue"),
            record: null,
        });
    });

    it("previews a chosen session", async () => {
        const { body } = await call("/admin/preview?session=3");
        expect(body).toMatchObject({ session: { n: 3 }, reminder: null });
        expect((body as { content: string }).content).toContain("Thanks for reading along");
    });

    it("rejects an unknown session", async () => {
        expect((await call("/admin/preview?session=9")).status).toBe(400);
    });

    it("force-posts to the test channel only, without ping, tags or state", async () => {
        const { status, discord, kv } = await call("/admin/force-post?session=2", {
            method: "POST",
            vars: { ROLE_ID: IDS.role, FORUM_TAGS: JSON.stringify({ AAA: IDS.tag }) },
        });
        expect(status).toBe(200);
        expect(discord.calls).toEqual([
            {
                method: "createForumPost",
                args: [
                    IDS.testChannel,
                    {
                        name: "AAA · Session 2 · Ch 3–4 + Epilogue",
                        content: expect.not.stringContaining("<@&"),
                        tagIds: [],
                        roleId: undefined,
                    },
                ],
            },
        ]);
        expect(kv.data.size).toBe(0);
    });

    it("force-posts in text mode as thread plus message", async () => {
        const { discord } = await call("/admin/force-post?session=1", {
            method: "POST",
            vars: { TEST_CHANNEL_MODE: "text" },
        });
        expect(discord.calls.map((c) => c.method)).toEqual(["createThread", "sendMessage"]);
        expect(discord.calls[0].args[0]).toBe(IDS.testChannel);
    });

    it("needs TEST_CHANNEL_ID to force-post", async () => {
        const res = await call("/admin/force-post?session=1", {
            method: "POST",
            vars: { TEST_CHANNEL_ID: "" },
        });
        expect(res.status).toBe(400);
    });

    it("respects DRY_RUN when force-posting", async () => {
        const { status, body, discord } = await call("/admin/force-post?session=1", {
            method: "POST",
            vars: { DRY_RUN: "true" },
        });
        expect(status).toBe(200);
        expect(body).toMatchObject({ dryRun: true, channelId: IDS.testChannel });
        expect(discord.calls).toEqual([]);
    });

    it("reports Discord errors as 502", async () => {
        const discord = new FakeDiscord();
        discord.failures.set("createForumPost", new DiscordHttpError("POST", "/x", 403, { message: "Missing Access" }));
        const res = await call("/admin/force-post?session=1", { method: "POST", discord });
        expect(res.status).toBe(502);
        expect(res.body).toMatchObject({ error: expect.stringContaining("Missing Access") });
    });

    it("reports invalid configuration as 500", async () => {
        const { status, body } = await call("/admin/preview", { vars: { CHANNEL_MODE: "voice" } });
        expect(status).toBe(500);
        expect(body).toMatchObject({ problems: ['CHANNEL_MODE must be "forum" or "text"'] });
    });
});
```

Note: `response.json<T>()` is the Workers-typed generic; at runtime in Node it is the standard `json()`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/admin.test.ts`
Expected: FAIL — cannot resolve `../src/admin.ts`.

- [ ] **Step 3: Implement `src/admin.ts`**

```ts
import { ConfigError, parseConfig, type Config, type Env } from "./config.ts";
import {
    DiscordClient,
    DiscordHttpError,
    DiscordNetworkError,
    type DiscordApi,
} from "./discord.ts";
import { isDue, localNow, pickThreadSession, postDate } from "./due.ts";
import type { Plan, Session } from "./plan.ts";
import { renderPost, renderReminder } from "./render.ts";
import { createSessionThread } from "./run.ts";

const json = (body: unknown, status = 200): Response => Response.json(body, { status });
const notFound = (): Response => new Response("Not found", { status: 404 });

/** Constant-time comparison via fixed-length digests. */
async function secretMatches(given: string, expected: string): Promise<boolean> {
    const encoder = new TextEncoder();
    const [a, b] = await Promise.all(
        [given, expected].map((s) => crypto.subtle.digest("SHA-256", encoder.encode(s))),
    );
    const x = new Uint8Array(a);
    const y = new Uint8Array(b);
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
    return diff === 0;
}

/** Admin HTTP API. Every path is 404 unless the ADMIN_SECRET secret is set. */
export async function handleRequest(
    request: Request,
    env: Env,
    plans: Record<string, Plan>,
    instant: number,
    discord?: DiscordApi,
): Promise<Response> {
    const secret = typeof env.ADMIN_SECRET === "string" ? env.ADMIN_SECRET : "";
    const url = new URL(request.url);
    if (secret === "" || !url.pathname.startsWith("/admin/")) return notFound();
    if (!(await secretMatches(request.headers.get("X-Admin-Secret") ?? "", secret))) {
        return json({ error: "unauthorized" }, 401);
    }

    let cfg: Config;
    try {
        cfg = parseConfig(env, plans);
    } catch (err) {
        if (err instanceof ConfigError) {
            return json({ error: "invalid configuration", problems: err.problems }, 500);
        }
        throw err;
    }

    if (request.method === "GET" && url.pathname === "/admin/preview") {
        return preview(cfg, env.STATE, url, instant);
    }
    if (request.method === "POST" && url.pathname === "/admin/force-post") {
        return forcePost(cfg, discord ?? new DiscordClient(cfg.token ?? ""), url);
    }
    return notFound();
}

/** The latest due session if unposted, else the next session not yet due. */
async function defaultSession(
    cfg: Config,
    kv: KVNamespace,
    instant: number,
): Promise<Session | undefined> {
    const now = localNow(instant, cfg.timezone);
    const due = pickThreadSession(cfg.sessions, now, cfg);
    if (due && (await kv.get(`session:${due.n}`)) === null) return due;
    return cfg.sessions.find(
        (s) => !isDue(postDate(s, cfg.postOffsetDays), now, cfg.postHour),
    );
}

async function preview(
    cfg: Config,
    kv: KVNamespace,
    url: URL,
    instant: number,
): Promise<Response> {
    const raw = url.searchParams.get("session");
    const session =
        raw === null
            ? await defaultSession(cfg, kv, instant)
            : cfg.sessions.find((s) => String(s.n) === raw);
    if (!session) {
        return json({ error: raw === null ? "no upcoming session" : `unknown session "${raw}"` }, 400);
    }
    const post = renderPost(cfg, cfg.sessions, session);
    const next = cfg.sessions.find((s) => s.n === session.n + 1);
    return json({
        session,
        postDate: postDate(session, cfg.postOffsetDays),
        title: post.title,
        content: post.content,
        reminder:
            next && cfg.reminderDaysBefore > 0 ? renderReminder(cfg.templates, next) : null,
        record: await kv.get(`session:${session.n}`, "json"),
    });
}

/** Posts a session to the test channel: no KV, no lock, no tags, no ping. */
async function forcePost(cfg: Config, discord: DiscordApi, url: URL): Promise<Response> {
    if (!cfg.testChannelId) return json({ error: "TEST_CHANNEL_ID is not set" }, 400);
    const raw = url.searchParams.get("session");
    const session = cfg.sessions.find((s) => String(s.n) === raw);
    if (!session) return json({ error: `unknown session "${raw}"` }, 400);

    const post = renderPost(
        { templates: cfg.templates, spoilerPolicy: cfg.spoilerPolicy },
        cfg.sessions,
        session,
    );
    if (cfg.dryRun) return json({ dryRun: true, channelId: cfg.testChannelId, ...post });
    try {
        const threadId = await createSessionThread(
            discord,
            cfg.testChannelId,
            cfg.testChannelMode,
            post,
            [],
        );
        if (cfg.testChannelMode === "text") await discord.sendMessage(threadId, post.content);
        return json({ posted: true, channelId: cfg.testChannelId, threadId, ...post });
    } catch (err) {
        if (err instanceof DiscordHttpError || err instanceof DiscordNetworkError) {
            return json({ error: err.message }, 502);
        }
        throw err;
    }
}
```

- [ ] **Step 4: Implement `src/index.ts`**

```ts
import { PLANS } from "../plans/index.ts";
import { handleRequest } from "./admin.ts";
import { parseConfig, type Env } from "./config.ts";
import { DiscordClient } from "./discord.ts";
import { runScheduled } from "./run.ts";

export default {
    async scheduled(controller, env) {
        const cfg = parseConfig(env, PLANS);
        await runScheduled(
            cfg,
            env.STATE,
            new DiscordClient(cfg.token ?? ""),
            controller.scheduledTime,
        );
    },

    fetch(request, env) {
        return handleRequest(request, env, PLANS, Date.now());
    },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all test files PASS; tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/admin.ts src/index.ts test/admin.test.ts
git commit -m "Add protected admin route and Worker entry point" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Wrangler config, local dry-run verification, README

**Files:**
- Create: `wrangler.toml`, `README.md`

**Interfaces:**
- Consumes: the whole Worker (`src/index.ts`), `npm run dev`/`deploy`/`schedule` scripts.
- Produces: deployable config for env `mistborn` (not deployed), setup documentation.

- [ ] **Step 1: Create `wrangler.toml`**

```toml
# Base config. Each read is its own [env.<name>], deployed as the Worker
# "reread-bot-<name>". The base has no cron, vars or KV, so a deploy
# without --env is inert.
name = "reread-bot"
main = "src/index.ts"
compatibility_date = "2026-10-01"

# ---------------------------------------------------------------- mistborn
[env.mistborn]
workers_dev = true # needed only for the optional admin route

[env.mistborn.triggers]
crons = ["0 * * * *"]

[[env.mistborn.kv_namespaces]]
binding = "STATE"
id = "REPLACE_WITH_KV_NAMESPACE_ID"

[env.mistborn.vars]
PLAN = "mistborn"
GUILD_ID = "REPLACE_WITH_GUILD_ID"
CHANNEL_ID = "REPLACE_WITH_CHANNEL_ID"
CHANNEL_MODE = "forum"            # "forum" or "text"
TIMEZONE = "America/Los_Angeles"
POST_HOUR = "9"                   # local hour, 0-23
POST_OFFSET_DAYS = "0"            # e.g. "-14" to open at the start of the reading window
ROLE_ID = ""                      # set to ping a role when a thread opens
FORUM_TAGS = "{}"                 # e.g. '{"TFE":"123...","WoA":"456..."}'
LOCK_PREVIOUS = "true"
REMINDER_DAYS_BEFORE = "3"        # "0" disables reminders
DRY_RUN = "false"
TEST_CHANNEL_ID = ""              # admin force-post target
SPOILER_POLICY = ""
# Templates default to DEFAULT_TEMPLATES in src/render.ts. Override any of
# THREAD_TITLE_TEMPLATE, OPENING_TEMPLATE, NEXT_TEMPLATE, FINAL_TEXT,
# REMINDER_TEMPLATE here, for example:
# OPENING_TEMPLATE = """
# **{bookTitle} — {range}**
# Session {n} of {total} · {date}
#
# {spoilerPolicy}
#
# {next}"""
```

- [ ] **Step 2: Start the local dev server (dry run, dummy IDs)**

Run in background:
`npx wrangler dev --env mistborn --test-scheduled --port 8787 --var DRY_RUN:true --var GUILD_ID:100000000000000001 --var CHANNEL_ID:100000000000000002`
Expected: "Ready on http://localhost:8787" (local mode; local KV; no Discord calls). If wrangler rejects the placeholder KV `id` locally, STOP and report — do not create a remote namespace.

- [ ] **Step 3: Determine the scheduled-trigger endpoint and `time` support**

Run each and note which returns HTTP 200:
- `curl -si "http://localhost:8787/__scheduled?cron=0+*+*+*+*"`
- `curl -si "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"`

Today (2026-10-02) is before session 1, so the dev log should show no `[dry-run]` line and no errors.

Then test the `time` parameter on the working endpoint with session 1's post time (2026-10-18 09:00 PDT): first `&time=1792339200000` (ms); if the log does not show `[dry-run] would open session 1`, try `&time=1792339200` (s). Record which endpoint and unit work (or that `time` is unsupported) for the README. Stop the dev server afterward.

- [ ] **Step 4: Create `README.md`**

Use the endpoint/`time` findings from Step 3 in the "Local testing" section (replace `<SCHEDULED_ENDPOINT>` and the `time` sentence accordingly — no placeholder may remain).

````markdown
# reread-bot

A Discord bot for group book reads. Runs as a Cloudflare Worker on an hourly
cron, opens a discussion thread for each session of a reading plan, and posts
a reminder in the current thread before the next session. REST API only — no
Gateway, no always-on process.

- Plans (what to read, when): `plans/<name>.ts`
- Deployments (where to post): `[env.<name>]` blocks in `wrangler.toml`
- Design: `docs/superpowers/specs/2026-10-02-reread-bot-design.md`

## Requirements

- Node 22.18+ (24 recommended), npm
- A Cloudflare account (free plan is fine; each deployment uses 1 of the
  account's 5 Cron Triggers)
- Discord server where you can manage roles and channels

```sh
npm install
npm test
npm run schedule mistborn   # print the computed schedule
```

## 1. Create the Discord application and bot

1. Open <https://discord.com/developers/applications> → **New Application**.
2. **Bot** tab → **Reset Token** → copy the token (you will store it as a
   secret; never commit it).
3. Leave all **Privileged Gateway Intents** off. Optionally turn off
   **Public Bot** so only you can invite it.
4. **General Information** → copy the **Application ID**.

## 2. Permissions and invite URL

| Permission | Why |
|---|---|
| View Channel | see the target channel |
| Send Messages | create forum posts |
| Create Public Threads | text mode threads |
| Send Messages in Threads | opening message (text mode), reminders |
| Manage Threads | lock/archive previous thread; delete an empty thread after a failed post |

Permissions integer: `326417517568`.

Invite URL (replace `APPLICATION_ID`):

```
https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&scope=bot&permissions=326417517568
```

If the channel has permission overrides, make sure the bot's role has these
permissions in that channel (and in the test channel).

Role pings: in **Server Settings → Roles → (role)**, enable **Allow anyone to
@mention this role**. Do not grant the bot Mention Everyone.

## 3. Get IDs (Developer Mode)

Enable **User Settings → Advanced → Developer Mode**, then:

- **Guild ID:** right-click the server icon → **Copy Server ID**.
- **Channel ID:** right-click the channel → **Copy Channel ID**.
- **Role ID:** **Server Settings → Roles** → right-click the role → **Copy Role ID**.
- **Forum tag IDs:** not shown in the client. With the bot invited, run:

  ```sh
  curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
    https://discord.com/api/v10/channels/FORUM_CHANNEL_ID | jq '.available_tags'
  ```

  and map book codes to tag IDs, e.g. `FORUM_TAGS = '{"TFE":"123…"}'`.

Put the IDs in the env's `[vars]` in `wrangler.toml`.

## 4. Cloudflare setup

```sh
npx wrangler login
npx wrangler kv namespace create reread-bot-mistborn
```

Copy the printed `id` into `[[env.mistborn.kv_namespaces]]` in `wrangler.toml`.
This is a separate Worker (`reread-bot-mistborn`); it does not touch any other
Worker on the account.

## 5. Secrets

```sh
npx wrangler secret put DISCORD_BOT_TOKEN --env mistborn
npx wrangler secret put ADMIN_SECRET --env mistborn   # optional; enables /admin/*
```

## 6. Configuration reference

All vars are strings in `[env.<name>.vars]`. Empty string = unset.

| Var | Default | Meaning |
|---|---|---|
| `PLAN` | required | key in `plans/index.ts` |
| `GUILD_ID`, `CHANNEL_ID` | required | Discord IDs |
| `CHANNEL_MODE` | required | `forum` or `text` |
| `TIMEZONE` | `America/Los_Angeles` | IANA zone for post times |
| `POST_HOUR` | `9` | local hour (0–23) |
| `POST_OFFSET_DAYS` | `0` | post this many days relative to the session date (`-14` = start of reading window) |
| `ROLE_ID` | — | role to ping when a thread opens |
| `FORUM_TAGS` | `{}` | JSON map of book code → forum tag ID |
| `LOCK_PREVIOUS` | `true` | archive + lock the previous thread |
| `REMINDER_DAYS_BEFORE` | `3` | reminder in the current thread N days before the next opens; `0` = off; must be < the plan interval |
| `DRY_RUN` | `false` | log instead of posting; no KV writes |
| `TEST_CHANNEL_ID` | — | admin force-post target |
| `TEST_CHANNEL_MODE` | `CHANNEL_MODE` | |
| `SPOILER_POLICY` | — | text for `{spoilerPolicy}` |
| `THREAD_TITLE_TEMPLATE` | `{bookShort} · Session {n} · {range}` | |
| `OPENING_TEMPLATE` | see `src/render.ts` | |
| `NEXT_TEMPLATE` | see `src/render.ts` | rendered into `{next}` |
| `FINAL_TEXT` | see `src/render.ts` | `{next}` for the last session |
| `REMINDER_TEMPLATE` | see `src/render.ts` | |

Placeholders: `{bookTitle} {bookShort} {n} {total} {range} {date}` (title,
opening); `{spoilerPolicy} {next}` (opening); `{nextBookTitle}
{nextBookShort} {nextRange} {nextDate}` (next, reminder). Unknown
placeholders fail validation; other braces are left as-is.

## 7. Local testing

```sh
npm run dev -- --env mistborn
```

This runs locally with `DRY_RUN` forced on and a local KV store — nothing is
sent to Discord. Trigger the cron:

```sh
curl "http://localhost:8787/<SCHEDULED_ENDPOINT>?cron=0+*+*+*+*"
```

<!-- Step 3 finding: how to simulate a date with `time`, or that it is unsupported. -->

Watch the dev server log for `[dry-run] would open session …`. With
`ADMIN_SECRET` in a local `.dev.vars` file, you can also preview:

```sh
curl -H "X-Admin-Secret: $ADMIN_SECRET" http://localhost:8787/admin/preview
```

## 8. Deploy

```sh
npm test
npm run deploy -- --env mistborn
npx wrangler tail --env mistborn   # live logs
```

Tip: deploy first with `DRY_RUN = "true"` and watch `wrangler tail` around
the post hour, then switch to `"false"` and redeploy.

## 9. Admin route (optional)

Enabled only when `ADMIN_SECRET` is set. Send it in the `X-Admin-Secret` header.

- `GET /admin/preview[?session=N]` — rendered title, opening message,
  reminder, post date and KV record (default: next session to post).
- `POST /admin/force-post?session=N` — posts session N to `TEST_CHANNEL_ID`
  (no KV changes, no tags, no ping, no locking).

## 10. Writing a plan

1. Copy `plans/mistborn.ts` to `plans/<name>.ts` and edit: `startDate`,
   `intervalDays`, `breaks` (inclusive date ranges whose slots are skipped),
   and `books` (structure + `"start-end"` session ranges using units `P`,
   chapter numbers, `part.chapter`, `E`, or `E1…En`).
2. Register it in `plans/index.ts`.
3. `npm run schedule <name>` and `npm test` (every registered plan is validated).

Changing a plan mid-read: sessions are tracked by number (`session:N` in KV).
Adding a break or changing future dates is safe; inserting or removing
sessions before ones already posted renumbers them, so avoid that.

## 11. Adding a deployment

Add `[env.<name>]`, `[env.<name>.triggers]`, `[[env.<name>.kv_namespaces]]`
and `[env.<name>.vars]` blocks (vars are not inherited), create a KV
namespace, set secrets with `--env <name>`, and deploy with
`npm run deploy -- --env <name>`. Each deployment uses one Cron Trigger
(free plan: 5 per account, shared with other Workers).

## 12. Recovering a stuck session

If a post attempt ended without a clear answer from Discord, the session is
left `pending` and every hourly run logs
`Session N is stuck pending … check Discord, then fix KV key "session:N"`.
The bot will not retry it (a missed post beats a duplicate). To fix:

- **Thread exists in Discord:** record it (use the thread ID from Discord):

  ```sh
  npx wrangler kv key put --env mistborn --binding STATE --remote "session:N" \
    '{"status":"posted","threadId":"THREAD_ID","startedAt":"2026-10-18T16:00:00Z"}'
  npx wrangler kv key put --env mistborn --binding STATE --remote "latest" \
    '{"n":N,"threadId":"THREAD_ID"}'
  ```

- **No thread exists:** delete the marker; the next hourly run posts it:

  ```sh
  npx wrangler kv key delete --env mistborn --binding STATE --remote "session:N"
  ```
````

When writing the file, replace the `<SCHEDULED_ENDPOINT>` and the HTML comment with the Step 3 findings.

- [ ] **Step 5: Final verification**

Run: `npm test && npm run typecheck && npm run schedule mistborn | head -3`
Expected: all tests PASS; tsc exit 0; first three schedule rows printed.
Run: `grep -n "SCHEDULED_ENDPOINT\|Step 3 finding" README.md` — Expected: no matches.

- [ ] **Step 6: Commit**

```bash
git add wrangler.toml README.md
git commit -m "Add wrangler config for the Mistborn deployment and README" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
