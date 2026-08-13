# syntax=docker/dockerfile:1
#
# One image, four stages. `dev` is what docker-compose runs by default (source
# is bind-mounted for hot reload); `runner` is the production image and is
# shared by both the web and worker services — they differ only in command.

FROM node:22-alpine AS base
# openssl is required by Prisma's query engine; libc6-compat smooths over
# glibc-built binaries on musl.
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# --- dependencies -----------------------------------------------------------
FROM base AS deps
# devDependencies are needed at build time (next, prisma, tsx). Playwright is
# among them for the smoke test, so stop its postinstall from pulling ~400MB of
# browsers into an image that never runs them.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# --- development ------------------------------------------------------------
FROM base AS dev
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev"]

# --- build ------------------------------------------------------------------
FROM base AS builder
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `npm run build` runs `prisma generate` first (see package.json).
RUN npm run build

# --- production runtime -----------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/src ./src
COPY --from=builder /app/worker ./worker
COPY --from=builder /app/docker ./docker

RUN chown -R nextjs:nodejs /app
USER nextjs

EXPOSE 3000
CMD ["npm", "run", "start"]
