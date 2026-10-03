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

`GUILD_ID` and `CHANNEL_ID` in `[env.mistborn.vars]` must hold real IDs
(section 3). To try it before setup, pass dummy IDs (safe: dry run never calls
Discord):

```sh
npm run dev -- --env mistborn
npm run dev -- --env mistborn --var GUILD_ID:100000000000000001 --var CHANNEL_ID:100000000000000002
```

The first form needs real IDs; the second works with the placeholders.

This runs locally with `DRY_RUN` forced on and a local KV store — nothing is
sent to Discord. Trigger the cron:

```sh
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"
```

(`/__scheduled?cron=...` also works.) Both need `--test-scheduled`, which
`npm run dev` already passes.

To simulate a date, add `&time=<epoch milliseconds>`, e.g.
`&time=1792339200000` (2026-10-18 09:00 PDT) makes the run behave as if it
were that moment.

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

If a post attempt ended without a clear answer from Discord (a network error,
a timeout, or a Discord server error), the session is left `pending` and every
hourly run logs
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
