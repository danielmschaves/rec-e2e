#!/bin/sh
# Worker start-up. The web container owns schema creation; the worker waits
# until the tables it needs actually exist before consuming jobs.
set -e

echo "[worker] generating Prisma client…"
npx prisma generate >/dev/null

echo "[worker] waiting for schema…"
attempt=1
until echo 'SELECT 1 FROM "Application" LIMIT 1;' | npx prisma db execute --stdin >/dev/null 2>&1; do
  if [ "$attempt" -ge 60 ]; then
    echo "[worker] schema never appeared — giving up" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 3
done

echo "[worker] starting…"
exec npm run worker
