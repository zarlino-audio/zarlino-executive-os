# Zarlino Executive OS — agent instructions

This repository is the brain of Zarlino Audio: the organization that turns the
founder's intent into shipped products. Everything here is bound by the
**Zarlino Constitution** — read `docs/CONSTITUTION.md` before making changes.

The short version, which decides most judgment calls:

1. **Work is a change, not a description.** A task is finished when something on
   disk is different and the difference is proven with raw output. A report
   describing what you would change is not a deliverable.
2. **Evidence over claims.** Every assertion carries its command, its output,
   its file path or its hash. Unverified things are labelled `UNVERIFIED` — that
   is a required status, not a weakness.
3. **One task, one owner, no twins.** Never create work that already exists;
   extend the existing task instead.
4. **One source of truth, and it is versioned.** Remember: this org once kept a
   whole engine as untracked files on one laptop. Commit and push real work.
5. **No fabrication.** No invented metrics, no placeholder behaviour presented
   as real, no faked test results. State limits, measure what is real, document
   the gap.
6. **Publishing is part of finishing.** Commit, push, package, record the
   version and the hash, publish where a machine or customer can fetch it.
7. **Write the lesson down the same day.** Add it to `/memories/repo/*` and the
   repo docs with the symptom, root cause and fix.

Engineering habits that this repository depends on:

- `npx tsc --noEmit` and `npx vitest run` must pass before deploying (deploy is
  `$env:CLOUDFLARE_API_TOKEN` from `.dev.vars` + `npx wrangler deploy`).
- Secrets never enter source, tasks, logs or chat. `.dev.vars` is git-ignored.
- A new behaviour earns a test; a fixed bug earns a test that fails without the
  fix.
- Migrations are additive and registered in `src/db/migrations.ts`; never edit an
  applied migration.
- The founder channel (`voice.ts`) is the one path that must never degrade
  silently: record which engine answered.
