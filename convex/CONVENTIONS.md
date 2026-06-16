# Supabase → Convex migration conventions

The contract every domain follows so ~116 tables and ~290 call sites translate
consistently and converge. The proven reference slice is the **email** domain:
`convex/schema/email.ts`, `convex/email/suppression.ts`, and the rewired
`lib/email/suppression.ts`. Copy its shape.

Authoritative source of truth for table shapes: **`supabase/schema.current.sql`**
(all 116 tables materialized) and `/tmp/schema_columns.txt` (per-column types).
Do NOT reconstruct shapes from individual migrations — use the materialized file.

## Verification (every change must pass these)

A live local Convex backend is the oracle. Bring it up / push / run:

```
bash scripts/convex-local.sh up          # start the local backend (idempotent)
npx convex dev --once --env-file /tmp/cvx-cli.env --typecheck disable   # push schema+fns, codegen
npx convex run --env-file /tmp/cvx-cli.env '<dir>/<module>:<fn>' '<jsonArgs>'   # run a function live
pnpm typecheck                            # whole project, incl convex/
```

A parity oracle Postgres (the old schema, all migrations applied) runs at
`psql -h /tmp -p 5499 cola` — use it to confirm a translated query returns the
same rows. **Only the integrator pushes** (concurrent `convex dev` races); agents
write code to this spec and verify by reading + `pnpm typecheck`.

## Schema translation (`convex/schema/<domain>.ts`)

Each domain file exports `export const <domain>Tables = { TableName: defineTable({...}) }`
and is spread into `convex/schema.ts`. Rules:

- **id**: keep the app's `gen_random_uuid()::text` PK as `id: v.string()`. Relationships
  use this string id, NOT Convex's native `_id`, so existing FKs / Stripe metadata /
  cookies / URLs keep working unchanged. (Convex still adds `_id` + `_creationTime`.)
- **indexes**: translate the indexes the code's query patterns need into
  `.index('by_x', ['colA','colB'])`. Index a table's `id` as **`by_app_id`** — ONLY
  when code looks the table up by id. **Never** name an index `by_id` or
  `by_creation_time` (reserved). Every non-trivial query must run on an index.
- **timestamps** (`TIMESTAMPTZ`): `v.string()` holding ISO-8601 (`new Date().toISOString()`).
- **enums** (`CHECK col IN (...)`): `v.union(v.literal('a'), v.literal('b'), ...)`.
- **nullable columns**: `v.optional(v.<t>())`. Absent ⇔ SQL NULL. Lib mappers coerce
  `undefined → null` at the boundary so the old `Row` shapes are preserved.
- **jsonb**: `v.any()` (or a `v.object({...})` if the shape is fixed and known).
- **integer cents / counts**: `v.number()`. **money stays integer cents** — never float.
- **boolean**: `v.boolean()`.
- No FKs / CHECK / RLS exist in Convex. Where a Postgres `ON DELETE CASCADE` or a
  unique index encodes real business behavior the code relies on, re-implement it
  inside the mutation (e.g. read-then-insert for uniqueness; explicit cascade deletes).
  Note in a comment which invariant you're preserving.

## Functions (`convex/<domain>/<module>.ts`, mirrors `lib/<domain>/<module>.ts`)

- Reads (`supabase.from(X).select().eq()...`) → `query({ args, handler })` using `withIndex`.
- Writes / multi-step ops over **one domain's own tables** → a single `mutation(...)`
  (Convex mutations are serializable — stronger than today's non-atomic Supabase
  writes; take that win). **Cross-domain orchestration stays in lib**: e.g.
  `markOrderPaid` (marketplace) keeps calling `recordConversion` (affiliates) as a
  lib→lib call; each module swaps only ITS OWN tables to Convex. Do NOT try to fold
  another domain's writes into your mutation in phase 1 — it breaks the parallel split
  and the cross-domain call graph. (Collapsing whole money flows into one transactional
  mutation is a phase-2 hardening, tracked separately.)
- Generate ids on insert with `crypto.randomUUID()`; set `createdAt: new Date().toISOString()`.
- Public `query`/`mutation` for now (the server is the trusted caller, matching the old
  service-role posture). **Do not** add ad-hoc `ctx.auth` checks — Clerk→Convex identity
  is a single dedicated pass after the data layer lands.
- Return the same shape the old `Row`/`WithProduct` interface returned (map `_id` away,
  expose `id`), so callers downstream are untouched.

## Lib rewrite (`lib/<domain>/<module>.ts`)

- Replace `supabase.from(...)` with `convex().query|mutation(api.<domain>.<module>.<fn>, args)`
  (`import { convex, api } from '@/lib/convex-server'`). Keep the lib function
  signatures and any non-DB orchestration. Drop the `@/lib/supabase` import.
- Keep pure logic (crypto, math, formatting) in lib — only the DB hop moves to Convex.

## Ownership / parallelism

One agent owns a domain end-to-end: its `convex/schema/<domain>.ts`,
`convex/<domain>/*.ts`, and the `lib/<domain>/*` rewrites. Agents never co-edit
`convex/schema.ts` (the integrator wires each fragment in) or `convex/_generated`
(regenerated centrally). No agent runs `convex dev` (push races).
