# Wave A spec — build the Convex data layer (schema + functions ONLY)

You are one of 10 parallel agents doing the FINAL Supabase→Convex cutover. 34
tables are already migrated across 8 reference domains. Your job: build the
Convex schema + functions for ONE domain's tables. **You do NOT edit any call
site** (lib/app/components) — a later wave rewires those to your functions. This
keeps the 10 agents collision-free (everyone writes only new convex/ files).

## READ FIRST
- `convex/CONVENTIONS.md` — the translation contract. Obey every rule.
- Reference domains to copy exactly: `convex/schema/{credits,marketplace,calendar}.ts`
  and `convex/{credits,marketplace,calendar}/*.ts`. (marketplace is the richest —
  money, uniqueness, transactional mutations, cross-domain notes.)
- Authoritative table shapes: `supabase/schema.current.sql` + `/tmp/schema_columns.txt`.

## WHAT TO BUILD
1. **`convex/schema/<domain>.ts`** exporting `export const <domain>Tables = { ... }`
   — a `defineTable` for EVERY table in your list, INCLUDING any with zero call
   sites (schema completeness so Supabase can be fully removed). Per CONVENTIONS:
   string `id`; ISO-8601 timestamps as `v.string()`; CHECK enums →
   `v.union(v.literal(...))`; nullable → `v.optional`; jsonb → `v.any()`; integer
   cents/counts → `v.number()`; bool → `v.boolean()`; text[] → `v.array(v.string())`.
   Add indexes matching the REAL query filters you find in the call sites.
   `by_app_id` ONLY where code looks the row up by its string id. NEVER name an
   index `by_id` or `by_creation_time` (reserved).
2. **`convex/<domain>/*.ts`** — comprehensive `query`/`mutation` functions covering
   EVERY operation the codebase performs on your tables. To enumerate them:
   `grep -rnE "\.from\('(Table1|Table2|…)'\)" lib app components` and READ each call
   site — capture every distinct read (filters, ordering, counts), write (insert
   payload), update (patch fields + filter), delete, and upsert. Make one function
   per distinct operation; mirror the existing lib function name where one exists.
   `crypto.randomUUID()` for ids; `new Date().toISOString()` for timestamps.
   Preserve every uniqueness/upsert invariant as read-then-insert/patch inside ONE
   serializable mutation. A within-domain multi-step write = one mutation.
   Return rows in the SAME shape the call sites expect (map `_id` away, expose
   `id`, coerce absent optionals → null).

## HARD CONSTRAINTS
- Edit ONLY `convex/schema/<domain>.ts` and `convex/<domain>/**`. Do NOT edit any
  call site, `convex/schema.ts`, `convex/_generated/*`, other domains' convex
  files, or `lib/convex-server.ts`. (The integrator wires your fragment in.)
- Convex module filenames: alphanumeric/underscore ONLY — NO hyphens (Convex
  rejects them).
- Do NOT run `npx convex`, `pnpm typecheck`, `pnpm build`, or git. Your functions
  won't codegen until the integrator pushes — that's expected.
- Money (if your domain has it): integer cents only, never float. Creator-facing =
  NET, seller-facing = GROSS. Don't recompute any money formula — mirror it.
- If a call site uses `.rpc('proc_name')` on your tables, reimplement that stored
  procedure's logic as a Convex mutation (or action) and say so in your report.

## REPORT (be exhaustive — the call-site wave depends on complete coverage)
- Every file created.
- Full function inventory: each fn name + signature + which call-site operation(s)
  it covers. The next wave maps `supabase.from(...)` calls to these, so missing
  coverage blocks them.
- Indexes added + why. Uniqueness/money invariants preserved + how.
- Any `.rpc()` proc reimplemented (which file, how). Any operation you couldn't
  model cleanly — flag it explicitly.
