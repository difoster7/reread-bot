# Reread Bot — Design

Date: 2026-10-02 · Status: approved in brainstorming, pending written-spec review

## 1. Purpose

A reusable book-club Discord bot that drives discussion by regularly opening
a thread for the chapters the group just read, and announcing what to read
next. The first deployment runs a 55-session Mistborn reread
(2026-10-18 → 2028-11-12). Books, chapter structures, session chunks and
cadence are data (a "plan"), not code, so the bot can be reused for future
reads.

### Constraints

- Cloudflare Worker on the free plan, triggered by Cron. Separate from the
  user's existing Worker; must not touch it.
- Discord REST API only (bot token). No Gateway, no slash commands, no
  privileged intents.
- TypeScript + Wrangler. No runtime dependencies; plain `fetch`.
- Secrets via `wrangler secret`, never in the repo.
- Nothing runs against the real Discord server without the user's approval.

### Reuse model

One deployment = one plan. Reuse is via multiple deployments of the same
codebase (wrangler environments), each its own Worker, KV namespace, cron and
config. Free plan allows 5 Cron Triggers per account (shared with the user's
other app).

### Out of scope

Scheduled Events (discussion is async), concurrent plans in one deployment,
per-session discussion prompts, recap messages, slash commands, schedule
changes without redeploy.

## 2. Plans

### Format

`plans/<name>.ts` default-exports a typed `Plan`; `plans/index.ts` is a
registry `{ [name]: Plan }` looked up by the `PLAN` var.

```ts
interface Plan {
  name: string;               // e.g. "Mistborn Reread"
  startDate: string;          // YYYY-MM-DD, first session's date
  intervalDays: number;       // > 0
  breaks: { from: string; to: string }[];  // inclusive date ranges
  books: PlanBook[];          // in reading order
}
interface PlanBook {
  short: string;              // unique code, e.g. "TFE"
  title: string;
  structure: BookStructure;
  sessions: string[];         // "start-end" unit ranges, in order
}
interface BookStructure {
  prologue?: boolean;
  chapters?: number;          // mutually exclusive with parts
  parts?: number[];           // chapter count per part (numbering restarts)
  epilogue?: boolean;         // single "E"
  epilogues?: number;         // numbered "E1".."En"; exclusive with epilogue
}
```

### Units

A structure expands to an ordered unit list:
`P`, then `1..chapters` or `p.c` for each part `p` and chapter `c`, then `E`
or `E1..En`. Session ranges reference these units, e.g. `"P-3"`, `"36-E"`,
`"1.1-3.3"`, `"71-E7"`.

### Schedule derivation

`buildSchedule(plan): Session[]`

```ts
interface Session {
  n: number;                  // 1-based, across the whole plan
  date: string;               // discussion date, YYYY-MM-DD
  book: { short: string; title: string };
  startUnit: string;
  endUnit: string;
  range: string;              // human label
}
```

- Candidate slots: `startDate + k × intervalDays`, k = 0, 1, 2, …
- A slot falling inside any break (inclusive) is skipped; sessions take the
  remaining slots in order.
- Post date (deployment concern, §4): `date + POST_OFFSET_DAYS`.

### Labels

Derived from the covered units:

| Units | Label |
|---|---|
| `P`–`3` | `Prologue–Ch 3` |
| `8`–`11` | `Ch 8–11` |
| `5`–`5` | `Ch 5` |
| `36`–`E` | `Ch 36–38 + Epilogue` |
| `1.1`–`3.3` | `Parts 1–3` |
| `4.1`–`E` | `Parts 4–6 + Epilogue` |
| `71`–`E7` | `Ch 71–74 + Epilogues 1–7` |

### Validation

`validatePlan(plan): string[]` (empty = valid). Checks:

- structure well-formed (chapters xor parts; epilogue xor epilogues; counts
  are positive integers);
- book codes unique; at least one session per book;
- every range parses and references existing units, start ≤ end;
- per book, ranges cover every unit exactly once, in order, no gaps/overlaps;
- `startDate` and break dates valid; `intervalDays` positive integer;
  each break `from ≤ to`.

Runs in tests (every registered plan) and at the start of every Worker run
(throws on errors).

### Mistborn plan (`plans/mistborn.ts`)

Start 2026-10-18, every 14 days, no breaks. Draft; may change.

| Book | Title | Structure | Sessions |
|---|---|---|---|
| TFE | The Final Empire | P, 1–38, E | P-3, 4-7, 8-11, 12-15, 16-19, 20-23, 24-27, 28-31, 32-35, 36-E |
| WoA | The Well of Ascension | 1–59, E | 1-6, 7-11, 12-17, 18-22, 23-28, 29-33, 34-39, 40-44, 45-50, 51-55, 56-E |
| HoA | The Hero of Ages | P, 1–82, E | P-8, 9-16, 17-25, 26-33, 34-42, 43-50, 51-59, 60-67, 68-75, 76-E |
| SH | Secret History | parts [2,4,3,4,3,9], E | 1.1-3.3, 4.1-E |
| AoL | The Alloy of Law | P, 1–20, E | P-5, 6-11, 12-16, 17-E |
| SoS | Shadows of Self | P, 1–26, E | P-5, 6-11, 12-17, 18-22, 23-E |
| BoM | The Bands of Mourning | P, 1–31, E | P-5, 6-11, 12-17, 18-22, 23-27, 28-E |
| TLM | The Lost Metal | P, 1–74, E1–E7 | P-11, 12-23, 24-35, 36-47, 48-59, 60-70, 71-E7 |

Totals 10 + 11 + 10 + 2 + 4 + 5 + 6 + 7 = 55 sessions; last date 2028-11-12.

### `npm run schedule <plan>`

`scripts/schedule.ts`, run with Node's built-in type stripping. Validates the
plan and prints one row per session: `#3  2026-11-15  TFE  Ch 8–11`.

## 3. Deployment config

### Wrangler layout

- Base `wrangler.toml`: `name = "reread-bot"`, `main`, `compatibility_date`.
  No triggers, vars or KV, so an accidental base deploy is inert.
- Each read is `[env.<name>]` with its own `vars`, `kv_namespaces`
  (binding `STATE`), `triggers.crons = ["0 * * * *"]`, `workers_dev = true`.
  Deploys as Worker `reread-bot-<name>`.
- First env: `mistborn`.

### Vars

| Var | Default | Notes |
|---|---|---|
| `PLAN` | required | key in `plans/index.ts` |
| `GUILD_ID` | required | snowflake |
| `CHANNEL_ID` | required | snowflake |
| `CHANNEL_MODE` | required | `forum` \| `text` |
| `TIMEZONE` | `America/Los_Angeles` | IANA |
| `POST_HOUR` | `9` | 0–23, local |
| `POST_OFFSET_DAYS` | `0` | integer; e.g. `-14` to open at start of reading window |
| `ROLE_ID` | empty | ping on thread open iff set |
| `FORUM_TAGS` | `{}` | JSON `{ "<bookShort>": "<tagId>" }`; forum mode only |
| `LOCK_PREVIOUS` | `true` | archive + lock previous thread on new open |
| `REMINDER_DAYS_BEFORE` | `3` | `0` disables; must be `< intervalDays` |
| `DRY_RUN` | `false` | |
| `TEST_CHANNEL_ID` | empty | admin force-post target |
| `TEST_CHANNEL_MODE` | `CHANNEL_MODE` | |
| `SPOILER_POLICY` | empty | rendered via `{spoilerPolicy}` |
| `THREAD_TITLE_TEMPLATE` | see below | |
| `OPENING_TEMPLATE` | see below | |
| `NEXT_TEMPLATE` | see below | |
| `FINAL_TEXT` | see below | |
| `REMINDER_TEMPLATE` | see below | |

### Secrets

- `DISCORD_BOT_TOKEN` — required unless `DRY_RUN`.
- `ADMIN_SECRET` — optional; unset disables the admin route.

### Templates

Placeholders:

- current session: `{bookTitle} {bookShort} {n} {total} {range} {date}`
- next session: `{nextBookTitle} {nextBookShort} {nextRange} {nextDate}`
- other: `{spoilerPolicy}`, `{next}`

`{next}` renders `NEXT_TEMPLATE`, or `FINAL_TEXT` for the last session.

Allowed placeholders per template:

| Template | Allowed |
|---|---|
| `THREAD_TITLE_TEMPLATE` | current session |
| `OPENING_TEMPLATE` | current session, `{spoilerPolicy}`, `{next}` |
| `NEXT_TEMPLATE`, `REMINDER_TEMPLATE` | next session |
| `FINAL_TEXT` | none |

In `REMINDER_TEMPLATE`, "next" is the session the reminder announces. Dates render as `Sunday, November 1, 2026`
(en-US, the date itself, no timezone shift). After rendering, 3+ consecutive
newlines collapse to 2 and the result is trimmed. Unknown or disallowed
placeholders fail `parseConfig`.

Defaults:

- `THREAD_TITLE_TEMPLATE`: `{bookShort} · Session {n} · {range}`
  (rendered title truncated to 100 chars with `…`)
- `OPENING_TEMPLATE`:
  ```
  **{bookTitle} — {range}**
  Session {n} of {total} · {date}

  {spoilerPolicy}

  {next}
  ```
- `NEXT_TEMPLATE`:
  `📖 **Read next:** {nextBookTitle}, {nextRange} — discussion opens {nextDate}.`
- `FINAL_TEXT`: `🎉 That's the end of the read. Thanks for reading along!`
- `REMINDER_TEMPLATE`:
  `⏰ **Reminder:** next discussion opens {nextDate} — {nextBookTitle}, {nextRange}.`

`{date}`/`{nextDate}` are discussion dates (plan dates). Rendered opening
messages longer than 2000 chars are an error.

### `parseConfig(env, plan): Config`

Typed result or throws listing all problems: required vars present, IDs are
numeric snowflakes, valid timezone (`Intl.DateTimeFormat` accepts it),
`POST_HOUR` 0–23, integers parse, booleans are `true`/`false`, `CHANNEL_MODE`
enum, `FORUM_TAGS` valid JSON whose keys are plan book codes,
`REMINDER_DAYS_BEFORE < plan.intervalDays`, templates use only allowed
placeholders, token present unless `DRY_RUN`.

## 4. Run logic

### 4.1 Hourly scheduled run

1. Look up plan (`PLAN`), `validatePlan`, `parseConfig`, `buildSchedule`.
   Any error: log and throw.
2. `now = controller.scheduledTime` → `{ today, hour }` in `TIMEZONE`
   via `Intl.DateTimeFormat#formatToParts`.
3. Thread step (§4.2), then reminder step (§4.3). A thread-step failure is
   logged and does not prevent the reminder step; the run rethrows at the end
   if either failed so the cron shows as failed.

### Due rule

`isDue(targetDate, now, postHour)`:
`targetDate < today || (targetDate == today && hour >= postHour)`.

Hourly local-time checks make DST irrelevant: a skipped local hour still
satisfies `>=` on the next run; a repeated hour is harmless (idempotent).

### 4.2 Thread step

1. `L` = latest session with `isDue(L.date + POST_OFFSET_DAYS)`. None → done.
2. `session:L` exists:
   - `posted` → done.
   - `pending` → log error ("session L stuck pending since …; verify in
     Discord, then fix KV — see README") → done.
3. Read `latest`. Warn for every session `k` with
   `(latest?.n ?? 0) < k < L`: "session k missed; not backfilled".
4. Post `L` (§4.4). On success write `session:L = posted`, then
   `latest = { n: L, threadId }`.
5. If `LOCK_PREVIOUS` and a previous `latest` existed:
   `archiveThread(prev.threadId, { locked: true })`. Failure logged, not
   retried.

### 4.3 Reminder step

1. Skip if `REMINDER_DAYS_BEFORE = 0`.
2. `N` = first session whose post date is not yet due. None → done.
3. Reminder target date = `N.postDate − REMINDER_DAYS_BEFORE`. Not due → done.
4. `reminder:N` exists → done. No `latest` → done (no thread before session 1).
5. `sendMessage(latest.threadId, render(REMINDER_TEMPLATE, N))`; write
   `reminder:N = { messageId, postedAt }`.

Reminders have no pending marker (duplicate reminder is low stakes) and never
ping the role.

### 4.4 Posting a session (pending marker)

1. Write `session:n = { status: "pending", startedAt }`.
2. Create:
   - forum: `createForumPost(CHANNEL_ID, title, content, tagIds)` where
     `tagIds = FORUM_TAGS[book.short]` if set.
   - text: `createThread(CHANNEL_ID, title)` then
     `sendMessage(threadId, content)`.
3. Outcomes:
   - success → write `{ status: "posted", threadId, startedAt, postedAt }`.
   - `DiscordHttpError` creating thread/post (definitively not created) →
     delete `session:n`; rethrow (retry next hour).
   - text mode, `DiscordHttpError` on the opening message →
     `deleteChannel(threadId)`; on success delete `session:n` and rethrow;
     if delete fails, write `posted` with `threadId`, log error loudly.
   - `DiscordNetworkError` (ambiguous) or Worker death → `pending` stays;
     later runs log error, never retry. Manual recovery documented.

Content: if `ROLE_ID` set, `<@&ROLE_ID>\n` prefixed to the opening message.

### KV schema (binding `STATE`, one namespace per deployment)

| Key | Value |
|---|---|
| `session:{n}` | `{ status: "pending" \| "posted", threadId?, startedAt, postedAt? }` |
| `latest` | `{ n, threadId }` |
| `reminder:{n}` | `{ messageId, postedAt }` |

### DRY_RUN

All logic runs and KV is read; rendered posts and intended actions are logged.
No Discord calls, no KV writes.

## 5. Discord client (`src/discord.ts`)

- Base `https://discord.com/api/v10`; headers `Authorization: Bot <token>`,
  `Content-Type: application/json`, `User-Agent: DiscordBot (reread-bot, 1)`.
- Each request uses `AbortSignal.timeout(10_000)`.
- 429: sleep `retry_after` seconds (JSON body; fallback `Retry-After`
  header), retry up to 3 times, then throw `DiscordHttpError`.
- Non-2xx → `DiscordHttpError { method, path, status, code, message, errors }`.
- `fetch` rejection / timeout → `DiscordNetworkError { method, path, cause }`.
- All errors logged with `console.error` as structured objects.
- Every message-creating call sends `allowed_mentions: { parse: [] }`, plus
  `roles: [ROLE_ID]` when pinging.

Methods:

| Method | Endpoint |
|---|---|
| `createForumPost(channelId, name, content, tagIds?, roleId?)` | `POST /channels/{id}/threads` with `name`, `auto_archive_duration: 10080`, `message`, `applied_tags` |
| `createThread(channelId, name)` | `POST /channels/{id}/threads`, `type: 11`, `auto_archive_duration: 10080` |
| `sendMessage(channelId, content, roleId?)` | `POST /channels/{id}/messages` |
| `archiveThread(threadId, { locked })` | `PATCH /channels/{id}` `{ archived: true, locked }` |
| `deleteChannel(id)` | `DELETE /channels/{id}` |

Posting to an auto-archived (unlocked) thread unarchives it, so reminders
still land after 7 quiet days.

### Bot permissions

View Channel, Send Messages (forum posts), Create Public Threads (text mode),
Send Messages in Threads, Manage Threads (lock/archive, delete on failure).
Role pings: make the role mentionable rather than granting Mention Everyone.
The README gives the computed permissions integer and invite URL
(`scope=bot` only).

## 6. Admin route (`src/admin.ts`)

Enabled only when `ADMIN_SECRET` is set; otherwise all paths 404.

- Auth: header `X-Admin-Secret`, compared via SHA-256 digests in constant
  time. Bad/missing → 401.
- `GET /admin/preview[?session=n]` → JSON: session, post date, rendered
  title, opening message, reminder text, KV record. Default session: the
  latest due session if unposted, else the next not-yet-due session.
- `POST /admin/force-post?session=n` → posts title + opening message to
  `TEST_CHANNEL_ID` in `TEST_CHANNEL_MODE`; no KV writes, no lock, no tags,
  no role ping. Respects `DRY_RUN`. 400 if `TEST_CHANNEL_ID` unset or
  session invalid.
- Any other path → 404.

## 7. Layout

```
plans/index.ts  plans/mistborn.ts
src/index.ts     handlers (fetch → admin, scheduled → run)
src/config.ts    parseConfig
src/plan.ts      Plan types, expandUnits, rangeLabel, validatePlan, buildSchedule
src/due.ts       localNow, addDays, isDue, pickThreadSession, pickReminder
src/render.ts    template rendering
src/discord.ts   REST client, error types
src/run.ts       scheduled orchestration
src/admin.ts     admin route
scripts/schedule.ts
test/*.test.ts
wrangler.toml  package.json  tsconfig.json  README.md  .gitignore
```

Dev dependencies only: `wrangler`, `typescript`, `vitest`,
`@cloudflare/workers-types`. Node ≥ 22.18 (type stripping) for scripts.

## 8. Testing

Plain Vitest in Node (code uses only `fetch`, `Intl`, `crypto.subtle`).
No network access in tests.

- `plan`: all registered plans valid; errors for gap, overlap, out-of-order,
  unknown unit, malformed range, bad structure, bad break; every label form;
  breaks shift subsequent dates.
- `mistborn`: 55 sessions; exact 14-day spacing; first 2026-10-18, last
  2028-11-12; book order.
- `due`: local date/hour conversion; `POST_HOUR` boundary; LA spring-forward
  (2027-03-14) and fall-back (2027-11-07); offset −14; missed runs pick the
  latest due session and report skipped ones; reminder target selection.
- `render`: all placeholders; final session uses `FINAL_TEXT`; unknown and
  disallowed placeholders rejected; newline collapse; title truncation;
  2000-char limit.
- `config`: each validation error; defaults applied.
- `discord`: 429 retry honors `retry_after` (fake timers); retry cap; HTTP vs
  network error classification; `allowed_mentions` always sent.
- `run` (in-memory KV + fake Discord client): posts once, second run no-op;
  pending released on HTTP error, kept on network error; stuck pending logs
  and skips; text-mode delete-on-message-failure; lock previous; dry run
  writes nothing; reminder once; no reminder before session 1.
- `admin`: 404 without secret, 401 bad secret, preview output, force-post
  targets test channel only.

### Local testing

`npm run dev -- --env mistborn` (script adds `--test-scheduled
--var DRY_RUN:true`; local KV). Trigger with the scheduled-handler endpoint
(`/__scheduled` or `/cdn-cgi/handler/scheduled` — confirm which, and whether
a `time` parameter is supported, against the installed Wrangler before
documenting).

## 9. README

Discord app + bot creation; permissions, integer and invite URL; Developer
Mode IDs (guild, channel, role, forum tags); KV namespace per env; secrets
per env; writing a plan; adding a deployment (and the 5-cron limit); local
testing; deploying; recovering a stuck `pending` session with
`wrangler kv key put/delete`.

## 10. Safety

No deploys, `wrangler secret put`, or calls against the real Discord server
without explicit user approval.
