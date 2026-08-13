# Operations

Running, configuring and troubleshooting the app. For *why* it is built this
way, see [ARCHITECTURE.md](./ARCHITECTURE.md); for day-to-day development, see
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Configuration

Every variable the code actually reads. Anything not listed here is not used.

### Required

| Variable | Used by | Notes |
| --- | --- | --- |
| `DATABASE_URL` | web, worker | Postgres connection string. Inside Docker the host is `db`; on the host it's `localhost`. |
| `SESSION_SECRET` | web | Signs the session JWT. Any change logs everyone out. Generate with `openssl rand -hex 32`. |

### Required in production

| Variable | Used by | Notes |
| --- | --- | --- |
| `APP_URL` | web | Public origin. Used to build the OAuth redirect and every post-auth redirect. Wrong value = broken sign-in. |
| `CRON_SECRET` | `/api/cron/sync` | Serverless sync auth. **The route returns 503 rather than running if unset** — it fails closed, it does not default to open. |

### Optional — features degrade cleanly without them

| Variable | Default | Effect when unset |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Assistant panel disabled with an explanatory message; everything else works. Application detection falls back to deterministic parsers only. |
| `ANTHROPIC_AUTH_TOKEN` | — | Alternative to the API key (OAuth token). The SDK resolves either. |
| `ASSISTANT_EFFORT` | `high` | `low`/`medium`/`high`/`xhigh`/`max`. `medium` is noticeably cheaper and quicker for chat. Invalid values fall back to `high`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Google sign-in and all sync disabled. Dev login still works. |
| `GOOGLE_REDIRECT_URI` | `${APP_URL}/api/auth/google/callback` | Only set it if your callback differs from the default. |
| `REDIS_URL` | `redis://localhost:6379` | The queue. Without it, "Sync now" runs inline instead of via the worker. |
| `SYNC_INTERVAL_MINUTES` | `5` | How often the worker re-syncs Google. |
| `DEV_LOGIN` | unset | **Never set this in a deployment.** See Security below. |
| `SEED_ON_BOOT` | — | Docker only. Seeds demo data on container start. |
| `NODE_ENV` | — | `production` enables secure cookies. |

### Docker Compose only

`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `WEB_PORT`, `DB_PORT`,
`REDIS_PORT`, `ADMINER_PORT`. These configure the containers, not the app.

### Test-only

`CHROME_PATH` and `SMOKE_SHOT_DIR` are read by `scripts/smoke.mjs`.

## Security

**`DEV_LOGIN` bypasses authentication by design.** The login page lists every
user in the database and signs you in as any of them with one click, no
password. It exists so the app is usable without Google credentials. It is
forced off in `docker-compose.prod.yml`; keep it unset everywhere else that is
not your laptop.

**What secrets the database holds.** `GoogleAccount` stores OAuth access and
refresh tokens in plaintext columns. A refresh token grants ongoing access to
the user's Gmail, Calendar and Drive until revoked. Treat a database dump as
equivalent to those mailboxes:

- Restrict network access to Postgres (the production compose file does not
  publish its port).
- Encrypt backups.
- On suspected compromise, revoke at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions) —
  deleting rows locally does not invalidate an already-issued token.
- Column-level encryption is a sensible next step and is not implemented.

**Scopes requested.** `gmail.readonly`, `gmail.send`, `calendar.events`,
`drive.file`, `drive.metadata.readonly`. `gmail.send` exists solely so *you* can
send an approved draft; the assistant has no path to it (see ARCHITECTURE).
Drive is scoped to files the app touches rather than the whole Drive.

**Multi-user.** Each Google sign-in creates its own isolated account. There is
no signup allowlist — anyone who can reach the app and has a Google account can
create one. Add one before exposing it publicly.

## Deploying

### Docker

```bash
cp .env.example .env     # fill in the required values
docker compose -f docker-compose.prod.yml up -d --build
```

Builds the compiled `runner` image, disables dev login and seeding, and keeps
Postgres and Redis off the host network. `web` and `worker` share one image and
differ only by command. The web container runs `prisma migrate deploy` before
starting.

### Vercel

Standard Next.js deploy, with two differences from Docker:

1. **No worker.** Vercel has no long-running process, so `vercel.json`
   registers a cron hitting `/api/cron/sync` every 10 minutes. Set
   `CRON_SECRET` or the route refuses to run.
2. **Managed data stores.** Point `DATABASE_URL` at Neon/Supabase/RDS and
   `REDIS_URL` at Upstash. The build command runs `prisma migrate deploy`.

## Health and monitoring

`GET /api/health` reports each dependency separately and returns 503 if any is
down:

```json
{ "status": "ok", "checks": { "database": "ok", "redis": "ok" } }
```

The **Setup** page shows sync history: per-provider run status, items seen,
items linked, new processes detected, rules fired, and the last error. That is
the first place to look when sync "isn't working".

`npm run inspect` prints every process and its stage flow to the terminal —
useful for confirming what the engine actually did.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Sign-in loops back to `/login` | `APP_URL` doesn't match the origin you're browsing, so the cookie is set on a different host. |
| `state_mismatch` on the OAuth callback | The `google_oauth_state` cookie expired (10 min) or you started the flow on a different host. |
| Google connected but nothing syncs | Check the Setup page's sync history for a stored error. A revoked refresh token surfaces there. |
| Mail syncs but lands nowhere | Matching needs a known contact address or a company email domain. Set a domain on the company. |
| An application confirmation didn't create a process | It must be inbound, unmatched, and pass the prefilter. Job alerts and rejections are deliberately excluded. Without `ANTHROPIC_API_KEY` only the deterministic parsers run. |
| Assistant panel says it's disabled | `ANTHROPIC_API_KEY` is unset. |
| Assistant replies with an API error | The error text is persisted into the transcript verbatim — read it there. |
| Everyone logged out after a deploy | `SESSION_SECRET` changed. |
| `/api/cron/sync` returns 503 | `CRON_SECRET` is unset. This is deliberate. |
| `/api/cron/sync` returns 401 | Bearer token doesn't match `CRON_SECRET`. |

## Database

Schema changes are applied with `prisma migrate deploy` in both Docker and
Vercel. `prisma/migrations/0_init` is a baseline generated from the schema.

To reset local data: `npm run db:reset` (destructive — drops everything and
re-seeds).

Back up with `pg_dump`; see the security note above about what a dump contains.
