# Security

## Reporting a vulnerability

Open a private security advisory on the repository, or email the maintainer
directly. Please don't file a public issue for anything exploitable.

## What this app holds

This is a personal job-search tracker wired into a Google account. The
sensitive material is:

- **Google OAuth refresh tokens** (`GoogleAccount`), stored in plaintext
  columns. A refresh token grants ongoing read access to the user's Gmail,
  Calendar and Drive — and send access on their behalf — until revoked at
  Google. **Treat a database dump as equivalent to those mailboxes.**
- **Mirrored email bodies** (`EmailMessage.bodyText`), for mail matched to a
  tracked process.
- **An Anthropic API key**, if the assistant is enabled. Email bodies, notes and
  challenge briefs are sent to the Anthropic API as assistant context.

Column-level encryption for the token fields is a sensible next step and is
**not** implemented.

## Design decisions that are load-bearing

**The assistant cannot send email.** Its `draft_email` tool writes a database
row. No tool calls Gmail's send API; `sendDraft` is reachable from exactly one
server action behind a user click. This is enforced by the shape of the tool
surface rather than by prompting, and `scripts/assistant-check.ts` asserts it on
every run. Keep it that way.

**`/api/cron/sync` fails closed.** It is an unauthenticated route that touches
every user's data, so it returns 503 when `CRON_SECRET` is unset rather than
defaulting to open.

**Ownership is re-checked on every mutation.** Server actions never trust an id
from the form; they re-query scoped to the session's `userId` first.

**Google is scoped narrowly.** `drive.file` and `drive.metadata.readonly`
rather than full Drive access. `gmail.send` exists only for the user's own
approved drafts.

## Known gaps

These are deliberate for an MVP, and are real if you deploy it for other people:

- **`DEV_LOGIN` bypasses authentication entirely.** It lists every account and
  signs you in as any of them, without a password. Forced off in
  `docker-compose.prod.yml`; never set it anywhere else.
- **No signup allowlist.** Anyone who can reach the app and holds a Google
  account can create one.
- **No rate limiting**, on sign-in or on assistant usage. Nothing caps what one
  account can spend against your Anthropic key.
- **No audit log for reads.** Writes are attributed in the timeline; reads are
  not recorded.
- **Tokens are not encrypted at rest** beyond whatever your database provides.

## If a token is compromised

Revoke at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
Deleting the row locally does **not** invalidate an already-issued token.
