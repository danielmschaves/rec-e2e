# Architecture

## Persona: you are the constant

Everything hangs off a single `User`. A company-side ATS models one company and
many candidates; this is the mirror image — one candidate (you) and many
companies, each running their own process on you. That inversion decides the
whole schema: `Opportunity` is *your* record of one company × role, and
`Company` / `Contact` exist mainly so inbound mail can be matched back to it.

## The central decision: opportunities own their stages

A naive tracker points an opportunity at a stage row in a shared list. That
makes it impossible to record what actually happens in a job search, which is
that no two companies run the same process.

Here, `ProcessTemplate` / `TemplateStage` are *your* expectation, and starting to
track an opportunity copies the stages onto it:

```
ProcessTemplate "Standard engineering loop"
  └── TemplateStage[]  applied, screen, take_home, …, accepted   (your flow)

Opportunity (Vela Health → Staff Engineer)
  └── OpportunityStage[]  applied, screen, -take_home-, …        (their process)
```

From then on the opportunity is self-contained. Vela waiving the take-home, or
Orbital inserting a pairing session, touches only their rows.
`Opportunity.flowMode` flips `STANDARD` → `PERSONALIZED` on first divergence,
which is what the UI badges as "diverged from your flow".

Two consequences worth stating:

- **Your template can change freely.** Editing a flow never rewrites the process
  of a company you're already mid-way through.
- **Skipping is not deleting.** A skipped stage stays with status `SKIPPED`,
  struck through in the tracker. The record stays honest about what they waived.

## Stage movement

All movement goes through `src/server/opportunities.ts`. `moveToStage` is the
primitive; `advanceStage` and every automation are built on it.

Moving *forward* marks every `PENDING`/`ACTIVE` stage before the target as
`COMPLETED`; moving *backward* reopens everything after it. `SKIPPED` stages are
left alone in both directions — being jumped over is exactly what a skipped
stage is for. Reaching a stage typed `OFFER`, `ACCEPTED` or `REJECTED` settles
the opportunity's status automatically.

Every move writes a `StageTransition` with an `actorType` of `USER`,
`ASSISTANT`, `AUTOMATION`, `SYNC` or `SYSTEM`. "Why does the tracker think I'm
at this stage?" is always answerable.

## Google sync

Three adapters, one shape. Each:

1. Pulls changes incrementally where the API allows — Gmail `history.list`,
   Calendar `syncToken`, Drive `changes.list` — falling back to a bounded window
   on first run or when a cursor expires (Gmail 404, Calendar 410).
2. Matches the artifact to a company you're in a process with.
3. Mirrors it locally (`EmailMessage`, `CalendarEvent`, `DriveFile`).
4. Emits a typed event to the rule engine.

Adapters never change a stage themselves. What Google observed is a fact; what
it means for your process is policy, and policy belongs in rules you can edit on
the Automations page.

### Matching

Two signals, in confidence order:

1. **A known contact's address.** `sara.lindqvist@nimbusdata.com` is on file, so
   the mail is Nimbus.
2. **The company's email domain.** A hiring manager who has never emailed you
   before still lands on the right process. Consumer domains (gmail.com,
   outlook.com, …) are excluded from this path — a gmail.com sender tells you
   nothing about which company they are.

When one company is running you through two roles, `pickOpportunity`
disambiguates by looking for a role title in the subject or body, else takes the
most recently active open one. Drive has no addresses in its metadata, so it
matches on the file's parent folder or the company name in the filename.

Unmatched mail is **skipped, not stored**. Syncing your inbox must not mean
copying your inbox.

### Idempotency

Every mirror table has a unique index on `(userId, externalId)` and adapters
check before inserting. Calendar "event finished" has no webhook, so it is a
sweep guarded by `completedHandledAt`; the gone-quiet check is guarded by
looking for a flag raised since the stage was entered.

## The rule engine

`src/server/automation.ts`. A rule is `trigger → conditions → action`:

```
EMAIL_RECEIVED_FROM_COMPANY
  conditions: { bodyContains: ["unfortunately", "not moving forward"] }
  action:     SET_OPPORTUNITY_STATUS { status: "REJECTED" }
```

Rules for a trigger are evaluated in `priority` order and **the first match
wins**, so two rules can't fight over one event. Conditions and action config
are JSON validated with Zod at evaluation time, so a malformed rule fails closed
rather than throwing mid-sync.

The seeded rules encode a sensible default: a reply while you're waiting closes
that stage, a rejection email closes the process, an offer email raises it to
the top, an invite naming a technical round moves you there, a finished
interview advances, and anything past its chase window gets a next action.

## The assistant

`src/server/ai/`. Three files: `client.ts` (model id and configuration),
`tools.ts` (the tool surface), `agent.ts` (the loop and system prompt).

**Model:** `claude-opus-5` with adaptive thinking, effort configurable via
`ASSISTANT_EFFORT` (default `high`).

**A hand-written loop, not the SDK's tool runner.** Every turn is persisted to
Postgres as it happens — assistant content blocks stored verbatim in
`AssistantMessage.blocks`, tool results as their own row — so a refresh
mid-answer loses nothing and the next turn replays the exact block sequence,
keeping `tool_use`/`tool_result` pairs intact. Owning the loop puts that
persistence in one obvious place. Tool results from a parallel turn are returned
in a **single** user message, as the API requires.

**Context is pre-loaded, not discovered.** A thread scoped to an opportunity
renders that opportunity — stages, contacts, next action — directly into the
system prompt, so the first question doesn't burn a tool call establishing which
company you mean. A challenge thread renders the brief and requirement list the
same way.

**The tool surface is small and prescriptive.** Seven tools, each described in
terms of *when* to call it rather than only what it does, which is what actually
drives correct selection. Inputs are validated with Zod and ownership-checked
against your `userId` before any write; a bad input comes back as a tool result,
never an exception.

### Why the assistant cannot send email

`draft_email` writes an `EmailDraft` row. There is no tool that calls Gmail's
send API. `sendDraft` lives in `src/server/sync/gmail.ts` and is reachable from
exactly one place — the `sendDraftAction` server action behind the Drafts page
button. This is a structural guarantee rather than an instruction the model
could be talked out of, and `assistant-check.ts` asserts it on every run.

## Background work

Docker runs a BullMQ worker with a repeatable job syncing every
`SYNC_INTERVAL_MINUTES`, plus on-demand jobs from "Sync now". Serverless has no
such process, so `/api/cron/sync` does the same work inline, driven by
`vercel.json` and protected by `CRON_SECRET`. Both call `syncAllAccounts()`.

Failures are isolated per provider — a Gmail outage must not stop Calendar. Each
run is recorded in `SyncRun` with counts and any error, which is what the Setup
page shows.

## Auth

A signed JWT (jose, HS256) in an httpOnly cookie. Google OAuth uses an offline
code flow with a `state` cookie for CSRF; refresh tokens are persisted and the
access token refreshed transparently within 60s of expiry — and a refresh
response omitting a refresh token never overwrites the stored one, a common way
to silently lose offline access.

`DEV_LOGIN=true` allows signing in as a seeded user without Google. It is off in
the production compose file and must stay unset in any real deployment.

## Deliberately out of scope

Called out so they read as decisions, not oversights:

- **Not verified against the live Anthropic API.** No key was available in the
  build environment. `assistant-check.ts` verifies the loop, tool dispatch,
  persistence and the never-sends guarantee against a stubbed client; what it
  cannot verify is that the model picks good tools or writes a good email.
- **Not verified against live Google APIs** either, for the same reason — the
  read/write adapters are unexercised network code. The engine that consumes
  their events is fully tested.
- **No streaming.** The assistant replies in one shot with a pending state.
  Streaming would want an API route and client-side accumulation; the tracker
  reads fine without it.
- **Single user per deployment.** Every query filters by `userId` and server
  actions verify ownership, so the model is ready for more — but sign-in creates
  or finds one account with no tenant resolution.
- **Push, not poll, is the endgame.** Gmail `watch` + Pub/Sub and Calendar push
  channels would cut latency to seconds. The cursor fields (`gmailHistoryId`,
  `calendarSyncToken`, `driveStartPageToken`) are already what a webhook handler
  needs.
- **Stage reordering is buttons, not drag-and-drop.** `reorderStages` takes an
  arbitrary ordering, so a drag surface is a UI change only.
- **Code review is conversational.** You paste code into the challenge assistant
  and it reviews it; there is no repository integration and nothing executes —
  that was the explicit scope decision for challenges.
