# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@latest --activate

# -------- deps --------
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile

# -------- build --------
FROM deps AS build
# Needed so `prisma generate` can detect OpenSSL on bookworm
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY prisma ./prisma
COPY tsconfig.json ./tsconfig.json
COPY tsconfig.build.json ./tsconfig.build.json
COPY src ./src
# Generate Prisma client at build time (schema must have debian-openssl-3.0.x)
RUN npx prisma generate
RUN pnpm build
RUN pnpm prune --prod && cp -R node_modules /app/node_modules_prod

# -------- runtime --------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update -y && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 10001 appuser
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules_prod ./node_modules
# ensure non-root can read everything
RUN chown -R appuser:appuser /app
USER appuser
EXPOSE 3000
# No runtime generate; just apply migrations then start
CMD ["bash","-lc","npx prisma migrate deploy && node dist/index.js"]