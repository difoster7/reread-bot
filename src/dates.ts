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
