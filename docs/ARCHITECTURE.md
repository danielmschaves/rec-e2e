# Architecture

## The central decision: applications own their stages

A naive ATS points an application at a stage row in a shared pipeline. That
makes personalisation impossible without either forking the pipeline per
candidate (unusable) or mutating a template other candidates depend on
(dangerous).

Here, `Pipeline` / `PipelineStage` are templates, and creating an application
copies the stages into `ApplicationStage` rows:

```
Pipeline "Standard Engineering Hire"
  └── PipelineStage[]  applied, resume_screen, …, hired      (the template)

Application (Marina → Senior Backend Engineer)
  └── ApplicationStage[]  applied, resume_screen, …, hired   (her own copy)
```

From then on, the application is self-contained. Adding a "Founder chat", or
skipping the take-home, touches only her rows. `Application.flowMode` flips from
`STANDARD` to `PERSONALIZED` on the first divergence, which is what the UI
badges and what lets you find flows that no longer match their template.

Two consequences worth stating:

- **Templates can change freely.** Editing a pipeline never rewrites the process
  of someone already midway through it.
- **Skipping is not deleting.** A skipped stage stays on the record with status
  `SKIPPED`, greyed out in the tracker. The history stays honest about what was
  waived and why.

## Stage movement

All movement goes through `src/server/applications.ts`. `moveToStage` is the
primitive; `advanceStage` and the automations are built on it.

Moving *forward* marks every `PENDING`/`ACTIVE` stage before the target as
`COMPLETED`. Moving *backward* reopens everything after it. `SKIPPED` stages are
left alone in both directions — being jumped over is exactly what a skipped
stage is for. Reaching a stage typed `HIRED` or `REJECTED` settles the
application status automatically.

Every move writes a `StageTransition` with an `actorType` of `USER`,
`AUTOMATION`, `SYNC` or `SYSTEM`, plus the rule id when an automation caused it.
"Why is this candidate at this stage?" is always answerable.

## Google sync

Three adapters, one shape. Each one:

1. Pulls changes incrementally where the API allows — Gmail `history.list`,
   Calendar `syncToken`, Drive `changes.list` — falling back to a bounded window
   on the first run or when a cursor expires (Gmail 404, Calendar 410).
2. Matches the artifact to a candidate.
3. Mirrors it into a local table (`EmailMessage`, `CalendarEvent`, `DriveFile`).
4. Emits a typed event to the rule engine.

Adapters never change a stage themselves. That separation is deliberate: what
Google observed is a fact, what it means for your process is a policy, and
policy belongs in rules a customer can edit.

### Matching

Email address is the join key — it is the one identifier present in a Gmail
header, a Calendar attendee list and a Drive share alike. `matchByEmails`
resolves the counterparty (for outbound mail, the recipients; for inbound, the
sender) against `Candidate.email`.

When a candidate is in flight for two roles, `matchWithJobHint` disambiguates by
looking for a job title in the subject or event description; otherwise it falls
back to the most recently active application. Drive has no addresses in its
metadata, so it matches on the file's parent folder first, then on the
candidate's name or email local-part appearing in the filename.

Unmatched artifacts are **skipped, not stored**. Syncing a recruiter's mailbox
should not mean copying their entire inbox into the ATS.

### Idempotency

Re-running a sync must not double-post. Every mirror table has a unique index on
`(orgId, externalId)` and adapters check before inserting. Calendar
"event finished" has no webhook, so it is a sweep guarded by a
`completedHandledAt` stamp; SLA breaches are guarded by looking for a flag raised
since the stage was entered.

## The rule engine

`src/server/automation.ts`. A rule is `trigger → conditions → action`, scoped
optionally to a pipeline or job.

```
EMAIL_RECEIVED_FROM_CANDIDATE
  conditions: { currentStageType: ["APPLIED", "SCREENING"] }
  action:     COMPLETE_CURRENT_STAGE
```

Rules for a trigger are evaluated in `priority` order and **the first match
wins**. Two rules can't fight over one event, which keeps behaviour predictable
when a customer adds their own. Conditions and action config are JSON validated
with Zod at evaluation time, so a malformed rule fails closed instead of
throwing mid-sync.

The seeded rules encode a sensible default process: a reply during screening
closes that stage, an event titled "technical interview" moves to that stage, a
finished interview advances, a cancellation flags for a human rather than
guessing.

## Background work

Docker runs a BullMQ worker (`worker/index.ts`) with a repeatable job that syncs
every `SYNC_INTERVAL_MINUTES`, plus on-demand jobs from the "Sync now" button.
Sync runs out-of-process so a slow Gmail backfill never blocks a request.

Serverless has no such process, so `/api/cron/sync` does the same work inline,
driven by the cron in `vercel.json` and protected by `CRON_SECRET`. Both paths
call the same `syncAllAccounts()`.

Failures are isolated per provider: a Gmail outage must not stop Calendar from
syncing. Each provider's run is recorded in `SyncRun` with counts and any error,
which is what the Integrations page shows.

## Auth

A signed JWT (jose, HS256) in an httpOnly cookie. Google OAuth uses an offline
access code flow with a `state` cookie for CSRF; refresh tokens are persisted and
the access token is refreshed transparently when within 60s of expiry — and a
refresh response that omits a refresh token never overwrites the stored one,
which is a common way to lose offline access.

`DEV_LOGIN=true` allows signing in as a seeded user without Google. It is off in
the production compose file and must stay unset in any real deployment.

## Deliberately out of scope for the MVP

Called out so they read as decisions rather than oversights:

- **Multi-tenancy is single-workspace.** Every query filters by `orgId` and
  server actions verify ownership before mutating, so the model is ready — but
  OAuth sign-in drops everyone into the first org rather than resolving a tenant.
- **No RBAC enforcement.** Roles exist on `User` and are displayed; no
  permission checks are wired to them yet.
- **Push, not poll, is the endgame.** Gmail `watch` + Pub/Sub and Calendar push
  channels would replace interval polling and cut latency to seconds. The cursor
  fields (`gmailHistoryId`, `calendarSyncToken`, `driveStartPageToken`) are
  already the ones a webhook handler needs.
- **Stage reordering is buttons, not drag-and-drop.** `reorderStages` takes an
  arbitrary ordering, so a drag surface is a UI change only.
- **Outbound Google actions are not verifiable here.** Sending a templated email
  and booking a Meet interview are wired end to end (`sendEmail`,
  `scheduleInterview`, exposed on the application page), but exercising them
  needs real OAuth credentials, so they are the one path not covered by the
  automated checks.
