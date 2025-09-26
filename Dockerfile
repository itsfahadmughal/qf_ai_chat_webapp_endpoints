# ---------- deps ----------
FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@latest --activate

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile

# ---------- build ----------
FROM deps AS build
# Prisma needs OpenSSL present for `get-config`/`generate`
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY prisma ./prisma
COPY tsconfig.json ./tsconfig.json
COPY tsconfig.build.json ./tsconfig.build.json
COPY src ./src
# Generate client (schema must have debian-openssl-3.0.x set)
RUN npx prisma generate
RUN pnpm build
RUN pnpm prune --prod && cp -R node_modules /app/node_modules_prod

# ---------- runtime ----------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update -y && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 10001 appuser
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules_prod ./node_modules
USER appuser
EXPOSE 3000
# Generate again for the running platform, migrate, start (future-proof)
CMD ["bash","-lc","npx prisma generate && npx prisma migrate deploy && node dist/index.js"]