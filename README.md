# Job search companion

One place for every recruitment process **you** are going through as a
candidate — with an assistant that has actually read the thread.

```
docker compose up
```

Then open <http://localhost:3000> and sign in with the dev login. A demo job
search is seeded: 5 companies, a take-home in flight, and 8 automation rules.

---

## Documentation

| | |
| --- | --- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it works and why — the stage engine, sync, detection, the assistant |
| [OPERATIONS.md](docs/OPERATIONS.md) | Every environment variable, deploy runbook, troubleshooting table |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Setup, conventions, how to verify a change |
| [SECURITY.md](SECURITY.md) | What secrets it holds, load-bearing design decisions, known gaps |

## The idea in one paragraph

You are the constant; the companies are the many. A **Flow** is your expectation
of how hiring goes — apply, screen, take-home, interviews, offer. When you start
tracking a company, that flow is *copied* onto them, and from then on their
process is theirs: Vela waived the take-home, Orbital added a pairing session,
Kestrel invented two extra rounds. You bend their copy to reality without ever
breaking your template. Meanwhile Google sync watches your inbox and calendar,
matches recruiter mail to the right company by address or domain, and moves the
stage for you. The assistant sits beside each process with that whole history in
context: ask it to chase someone and it drafts the email — **it can't send**,
only you can.

## What's in the box

| Area | What it does |
| --- | --- |
| **Processes** | One record per company × role: their stages, timeline, contacts, docs |
| **Personalisation** | Add / skip / restore / reorder *their* steps, never your template |
| **Assistant** | In context on every process and challenge; reads real state via tools |
| **Drafts** | AI-written email you review and send — the assistant has no send path |
| **Challenges** | Paste a take-home brief → checkable requirements, a plan, a deadline |
| **Auto-tracking** | Application confirmations from LinkedIn/ATS become tracked processes |
| **Gmail sync** | Files recruiter correspondence onto the right process |
| **Calendar sync** | An invite moves the stage; the interview ending advances it |
| **Drive sync** | Picks up briefs, CVs and solutions named after a company |
| **Automations** | Rules mapping each signal to a process change — editable, not hard-coded |
| **Audit trail** | Every change records whether it was you, a rule, sync, or the assistant |

## Applying is the only manual step

When you apply, something always emails you a receipt. The Gmail sync reads it,
works out the company and role, and creates the tracked process for you —
starting on **Applied**, not Researching.

Known senders (LinkedIn, Greenhouse, Lever, Ashby, Workday, Workable,
SmartRecruiters, …) are parsed deterministically at zero cost; anything else
falls back to a cheap structured-output call. Job alerts, newsletters and
rejections are filtered out before either runs.

Detected processes are live immediately, with a banner naming the source and a
one-click role correction — or "not mine" if the guess was wrong.

## The one safety rule

**The assistant cannot send email.** Its `draft_email` tool writes an
`EmailDraft` row and nothing else; the Gmail send path is reachable only from
the Drafts page, behind your click. This is enforced in the tool layer, not by
prompting, and `scripts/assistant-check.ts` asserts it (`draft is unsent`, `no
sent timestamp`, `no gmail id`).

## Running it

### Docker (everything)

```bash
cp .env.example .env          # add ANTHROPIC_API_KEY to enable the assistant
docker compose up             # web :3000, adminer :8080, postgres, redis, worker
```

The web container generates the Prisma client, applies migrations and seeds demo
data on boot. The worker runs the BullMQ consumer and re-syncs Google every
`SYNC_INTERVAL_MINUTES`.

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

Compiled image, dev login disabled, no seeding, datastores off the host network.

## Configuring the assistant

Set `ANTHROPIC_API_KEY`. Without it every other feature works and the assistant
panel is disabled with an explanatory message.

- **Model:** `claude-opus-5`, with adaptive thinking on.
- **Effort:** `ASSISTANT_EFFORT` (`low`…`max`, default `high`). `medium` is
  noticeably cheaper and quick for chat; raise it for challenge planning.
- **Who you are:** the Setup page has a free-text profile — seniority, stack,
  salary expectations, what you'd turn down. It goes into every system prompt,
  and it is the single biggest lever on draft quality.

The assistant's tools are read-state, `draft_email`, `set_next_action`,
`move_stage`, `add_note`, `set_challenge_requirements` and `set_challenge_plan`.
Every mutation is attributed to `ASSISTANT` in the timeline.

## Connecting Google Workspace

Everything works without Google — you just lose automatic updates. To enable:

1. In [Google Cloud Console](https://console.cloud.google.com/), create a
   project and enable the **Gmail**, **Calendar** and **Drive** APIs.
2. Configure the OAuth consent screen.
3. Create an OAuth **Web application** client with redirect URI
   `http://localhost:3000/api/auth/google/callback`.
4. Put the client ID and secret in `.env`, restart, and click **Connect Google**
   on the Setup page.

Scopes: `gmail.readonly`, `gmail.send`, `calendar.events`, `drive.file`,
`drive.metadata.readonly`. `gmail.send` exists solely so *you* can send an
approved draft from the Drafts page.

Matching is by known contact address first, then company email domain — set a
domain on each company and mail from anyone there lands on the right process.

## Deploying to Vercel

Standard Next.js. Two differences from Docker:

- **No worker.** `vercel.json` registers a cron calling `/api/cron/sync` every
  10 minutes. Set `CRON_SECRET` — the route refuses to run without it.
- **Managed data stores.** Point `DATABASE_URL` at Neon/Supabase and `REDIS_URL`
  at Upstash. The build command runs `prisma migrate deploy`.

Required: `DATABASE_URL`, `REDIS_URL`, `APP_URL`, `SESSION_SECRET`,
`CRON_SECRET`, `ANTHROPIC_API_KEY`, and the Google pair. Keep `DEV_LOGIN` unset
anywhere real — it bypasses authentication by design.

## Verifying it works

```bash
npm run check              # typecheck + all three suites — 81 assertions, no API key needed
npm run check:smoke        # drives the UI in a real browser, with screenshots
npm run inspect            # prints every process and its stage flow
curl localhost:3000/api/health
```

Individually: `check:e2e` (31 assertions — engine, automations, tools),
`check:assistant` (23 — the agent loop), `check:detection` (27 — real ATS
emails → tracked process).

`e2e-check` creates a throwaway company, walks it through the lifecycle —
standard flow, personalisation, each automation trigger, the assistant's tools —
then deletes what it made. `assistant-check` drives the real agent loop against
a stubbed model, so it verifies tool dispatch, transcript persistence, history
replay and the never-sends guarantee **without** an API key. `detection-check`
runs realistic confirmation emails from seven systems through the parsers, and
asserts that job alerts and rejections create nothing.

## Multiple people

Yes. Each Google sign-in creates its own account with fully isolated data —
every query filters by user and every server action re-checks ownership before
writing. Before putting it in front of others: keep `DEV_LOGIN` unset (it lists
every account and lets you sign in as any of them), add a signup allowlist, and
cap assistant spend per user.

## Layout

```
prisma/schema.prisma       data model (see docs/ARCHITECTURE.md)
src/server/opportunities   stage engine: create, move, personalise
src/server/automation      rule engine: triggers, conditions, actions
src/server/ai/             client, tools, the agent loop
src/server/sync/           gmail.ts, calendar.ts, drive.ts, match.ts, detect.ts
src/app/                   Next.js App Router pages and server actions
worker/                    BullMQ consumer + repeatable sync schedule
scripts/                   e2e-check, assistant-check, detection-check, smoke, inspect
```

How matching, the rule engine and the assistant work — and what is deliberately
left out — is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
