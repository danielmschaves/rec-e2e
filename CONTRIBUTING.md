# Contributing

## Getting set up

Needs Node 20+, Postgres and Redis. Docker gives you all three:

```bash
cp .env.example .env
docker compose up            # web :3000, adminer :8080, postgres, redis, worker
```

Or run against local services:

```bash
npm install
npx prisma migrate deploy
npx tsx prisma/seed.ts
npm run dev                  # web
npm run worker               # background sync, second terminal
```

Sign in with the dev login. The seed creates a realistic job search: 5
companies at different stages, a take-home in flight, one process the inbox
scanner "detected", and 8 automation rules.

## Verifying a change

```bash
npm run check                # typecheck + all three suites (no API key needed)
npm run check:smoke          # drives the UI in a real browser (needs the app running)
```

The suites are plain `tsx` scripts, not a test framework. They run against a
real Postgres, create their own throwaway data, assert, and clean up after
themselves.

| Command | What it covers |
| --- | --- |
| `npm run check:e2e` | The process engine: flow instantiation, stage movement, personalisation, every automation trigger, the assistant's tools |
| `npm run check:assistant` | The agent loop against a stubbed model — tool dispatch, transcript persistence, history replay, and the never-sends guarantee |
| `npm run check:detection` | Real-shaped confirmation emails from seven ATS systems, plus negative cases that must create nothing |
| `npm run check:smoke` | The whole UI in Chromium, with screenshots to `/tmp/rec-e2e-shots` |

**Add to the suites when you change behaviour.** A new automation trigger, tool,
or ATS parser should come with assertions. Both `e2e-check` and
`detection-check` are structured as numbered sections with a `check()` helper —
follow the existing shape.

None of the suites need an Anthropic API key. `assistant-check` injects a stub
client through `sendMessage({ client })`, which is the only reason that
parameter exists.

## Conventions

**Server-first.** Pages are async React Server Components that query Prisma
directly; mutations are `<form action={serverAction}>`. There is exactly one
client component (`AssistantPanel`), and it needs the client only for pending
state. Don't add `"use client"` without a reason you can state.

**Every query filters by `userId`.** Every server action re-checks ownership
before mutating — see the `ownedOpportunity` helper in `src/app/actions.ts`.
This is the whole of the multi-tenancy story, so it has to be uniform.

**The engine owns stage changes.** Don't write to `OpportunityStage` directly
from a page or action; go through `src/server/opportunities.ts` so transitions
and activity get recorded with the right actor.

**Sync adapters don't change stages.** They emit typed events to
`src/server/automation.ts` and let rules decide. Keeping "what Google said"
separate from "what that means" is why the rules are editable at runtime.

**The assistant cannot send email.** There is no tool that calls Gmail's send
API, and `sendDraft` is reachable from exactly one server action behind a user
click. If you add a tool, keep it that way — this is a structural guarantee, not
a prompt instruction, and `assistant-check` asserts it.

**Visual vocabulary lives in `src/lib/ui.ts`.** Status colours, `relativeTime`,
`inputClass`. Import them rather than re-picking classes per component.

## Project layout

```
prisma/schema.prisma      the data model, commented
src/server/opportunities  stage engine: create, move, personalise
src/server/automation     rule engine: triggers, conditions, actions
src/server/sync/          gmail, calendar, drive, match, detect
src/server/ai/            client, tools, agent loop
src/app/                  routes; actions.ts holds every mutation
src/components/           Shell, StageTracker, ActivityFeed, AssistantPanel
scripts/                  verification suites and the inspect utility
docker/                   container entrypoints
```

## Database changes

Edit `prisma/schema.prisma`, then:

```bash
npx prisma db push          # local iteration
npm run check               # confirm nothing broke
```

Before opening a PR, regenerate the migration baseline so deploys stay in sync:

```bash
rm -rf prisma/migrations/0_init && mkdir -p prisma/migrations/0_init
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/0_init/migration.sql
```

## Pull requests

Fill in the template. The parts reviewers actually rely on are **how you
verified it** (paste the suite output) and **what you did not verify** — this
codebase has real untested edges (live Google APIs, live model calls), and
saying so plainly is more useful than implying full coverage.
