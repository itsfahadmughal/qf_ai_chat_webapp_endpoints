# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@latest --activate

# ---------- deps ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile

# ---------- build ----------
FROM base AS build
# install openssl for Prisma get-config / generate
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY prisma ./prisma
COPY tsconfig.json ./tsconfig.json
COPY tsconfig.build.json ./tsconfig.build.json
COPY src ./src
RUN pnpm prisma:generate
RUN pnpm build
RUN pnpm prune --prod && cp -R node_modules /app/node_modules_prod

# ---------- runtime ----------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# openssl in runtime too (safe)
RUN apt-get update -y && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 10001 appuser
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules_prod ./node_modules
USER appuser
EXPOSE 3000
# Generate for the running platform, then migrate, then start
CMD ["bash","-lc","npx prisma generate && npx prisma migrate deploy && node dist/index.js"]