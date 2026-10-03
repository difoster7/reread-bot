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
