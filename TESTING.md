# Testing

## Unit tests

```
pnpm test:unit
```

Runs the Vitest suite under `tests/unit`, covering pure helpers (suggestions, chat summary, provider adaptation, file context, etc.).

## End-to-end tests

```
pnpm test:e2e
```

Boots a Fastify instance with Fastify’s auth stack, wires in a lightweight in-memory Prisma mock, seeds a hotel/user, and exercises the conversations and chat endpoints (creation, listing, message reads, chat completions, and deletion). Use this before pushing to verify the HTTP flow and auth guards.

## Full suite

```
pnpm test
```

Executes both unit and E2E tests consecutively.
