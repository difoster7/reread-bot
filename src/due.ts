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
