#!/bin/sh
# Web container start-up: make sure the schema and client are in place before
# Next boots, so a fresh `docker compose up` needs no manual steps.
set -e

echo "[web] generating Prisma client…"
npx prisma generate >/dev/null

echo "[web] applying migrations (retrying until the database accepts them)…"
attempt=1
until npx prisma migrate deploy; do
  if [ "$attempt" -ge 30 ]; then
    echo "[web] database never became ready — giving up" >&2
    exit 1
  fi
  echo "[web] database not ready yet (attempt $attempt), retrying in 2s…"
  attempt=$((attempt + 1))
  sleep 2
done

if [ "${SEED_ON_BOOT}" = "true" ]; then
  echo "[web] seeding demo data (idempotent)…"
  npx tsx prisma/seed.ts || echo "[web] seed skipped"
fi

echo "[web] starting Next.js…"
exec npm run dev
