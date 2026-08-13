# Recruitment E2E

An end-to-end recruitment platform: it follows a candidate through every phase
of hiring, lets each candidate's process be personalised without abandoning your
standard flow, and keeps itself up to date by syncing with Gmail, Calendar and
Drive.

```
docker compose up
```

Then open <http://localhost:3000> and sign in as **Alex Rivera** with the dev
login. Demo data (3 pipelines, 3 jobs, 8 candidates, 7 automation rules) is
seeded automatically.

---

## The idea in one paragraph

A **Pipeline** is a reusable template. When a candidate applies, the template's
stages are *copied* onto the application, which from then on owns its own flow.
That copy is what makes personalisation safe: you can add a "Founder chat" for
one candidate, waive the take-home for a strong referral, or reorder two
interviews — and no other candidate, and no template, changes. Meanwhile the
Google sync watches mail, meetings and documents, matches them to candidates by
email address, and feeds them to a rule engine that decides what each signal
means for the process. Booking an interview moves the stage. Finishing it
advances. A stalled stage raises a flag.

## What's in the box

| Area | What it does |
| --- | --- |
| **Pipelines** | Reusable stage templates with types, SLAs and optional steps |
| **Jobs** | A role, bound to a pipeline, with a kanban board of its candidates |
| **Applications** | The core record: stage tracker, timeline, notes, scorecards |
| **Personalisation** | Add / skip / restore / reorder stages per candidate |
| **Gmail sync** | Files candidate correspondence onto the timeline |
| **Calendar sync** | Detects interviews being booked, finished and cancelled |
| **Drive sync** | Picks up résumés, assessments and offer letters |
| **Automations** | Rules mapping Google signals to process changes |
| **Audit trail** | Every stage change records who or what caused it |

## Running it

### Docker (everything)

```bash
cp .env.example .env          # adjust as needed
docker compose up             # web :3000, adminer :8080, postgres, redis, worker
```

The web container generates the Prisma client, applies migrations and seeds demo
data on boot, so a clean checkout comes up working. The worker container runs
the BullMQ consumer and re-syncs Google every `SYNC_INTERVAL_MINUTES`.

### Locally, without Docker

Needs Postgres and Redis on the usual ports.

```bash
npm install
npx prisma migrate deploy
npx tsx prisma/seed.ts
npm run dev        # web
npm run worker     # background sync, in a second terminal
```

### Production-shaped

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Builds the compiled `runner` image, disables dev login and seeding, and keeps
Postgres and Redis off the host network.

## Connecting Google Workspace

Everything works without Google — you just don't get automatic updates. To
enable sync:

1. In [Google Cloud Console](https://console.cloud.google.com/), create a
   project and enable the **Gmail**, **Calendar** and **Drive** APIs.
2. Configure the OAuth consent screen (Internal is fine for a workspace).
3. Create an OAuth **Web application** client. Add the redirect URI:
   `http://localhost:3000/api/auth/google/callback`
4. Put the client ID and secret in `.env`, restart, and click **Connect Google**
   on the Integrations page.

Scopes requested: `gmail.readonly`, `gmail.send`, `calendar.events`,
`drive.file`, `drive.metadata.readonly`. Drive is deliberately scoped to files
the app touches rather than the user's whole Drive.

## Deploying to Vercel

The app is a standard Next.js project and deploys as-is. Two things differ from
Docker:

- **No worker.** Vercel has no long-running process, so `vercel.json` registers
  a cron that calls `/api/cron/sync` every 10 minutes. Set `CRON_SECRET` — the
  route refuses to run without it rather than defaulting to open.
- **Managed database.** Point `DATABASE_URL` at Neon/Supabase/RDS and
  `REDIS_URL` at Upstash. The build command runs `prisma migrate deploy`.

Required environment variables: `DATABASE_URL`, `REDIS_URL`, `APP_URL`,
`SESSION_SECRET`, `CRON_SECRET`, and the Google pair. Keep `DEV_LOGIN` unset in
any deployment — it bypasses authentication by design.

## Verifying it works

Three checks, all runnable against a live stack:

```bash
npx tsx scripts/e2e-check.ts   # 22 assertions on the process engine
node scripts/smoke.mjs         # drives the UI in a real browser, screenshots
npx tsx scripts/inspect.ts     # prints every application's stage flow
curl localhost:3000/api/health # database + redis liveness
```

`e2e-check` creates a throwaway job and candidate, walks them through the whole
lifecycle — standard flow, personalisation, and each automation trigger the sync
emits — then deletes what it made. `smoke.mjs` signs in, creates its own
candidate, personalises the flow and adds a note, failing on any console error.

## Layout

```
prisma/schema.prisma      data model (see docs/ARCHITECTURE.md)
src/server/applications   stage engine: create, move, personalise
src/server/automation     rule engine: triggers, conditions, actions
src/server/sync/          gmail.ts, calendar.ts, drive.ts, match.ts
src/app/                  Next.js App Router pages and server actions
worker/                   BullMQ consumer + repeatable sync schedule
scripts/                  e2e-check, smoke, inspect
docker/                   container entrypoints
```

More detail — including how matching and the rule engine work, and what is
deliberately left out of the MVP — is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
