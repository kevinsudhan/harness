# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **domain-specific harness**: a fixed kernel (state machine, policy gate, audit ledger, commitments, cut-off sentinel) that runs any service business from a config file, plus a builder that turns one line of English into a deployed app.

The kernel is code and never learns which business it is serving. A **vertical** (`src/verticals/`) is pure data — lifecycle states, legal actions per state, which actions always need a human, and the numeric brakes. Eleven ship: freight, recruitment, dental, veterinary, legal, real estate, catering, repair, gym, salon, tutoring. Adding an industry is writing one config, not forking the system.

n8n is the orchestrator, Cognee is memory, Supabase holds records. Voice agents (SnapServe) have **no webhook tools** by design — tool results don't reach the model on the Gemini Live stack — so their `webhookUrl` posts the finished call to n8n, which calls this service. Commitments are extracted after the call, not mid-conversation.

## Commands

TypeScript run directly with `tsx` — there is no build step.

```bash
npm install
npm start                 # server on :8788 (src/http/server.ts)
npm run dev               # tsx watch
npm test                  # domain/engine tests + n8n workflow validation + substitute.test.mjs
npm run test:domain       # just the TS tests
npx tsx src/engines/rfq.test.ts        # a single test file
npx tsc --noEmit          # typecheck (no lint configured)
npm run check:workflows   # structural validation of n8n/*.json
node scripts/demo.mjs     # slide-5 scenario end to end against a running server
node scripts/n8n-deploy.mjs [--apply]            # dry run by default
node scripts/wire-agent-webhook.mjs <url> [--apply]

npm run builder:web       # builder UI on http://127.0.0.1:8790 (loopback only)
npm run builder:lan       # same, also on this network for devices with the access key (builds/.lan-key)
npm run builder:public    # hosted mode (Render): $PORT, no key, CORS for BUILDER_ALLOWED_ORIGINS, apps at /apps/<build>/ — docs/HOSTING.md
npm run deploy -- <build>                      # plan a build's deployment to Cognee, SnapServe, n8n (GETs only)
npm run deploy -- <build> --apply --by=<name>  # do it; --undeploy [--apply] removes exactly what it made
npm run fork -- [--force] [--build] "a dental clinic that books by phone"   # new business from the template
npm run builder -- "change request"     # extend mode: plan a change to this system
npm run manifest          # what the builder sees in the live system
npm run residue           # freight literals still hard-coded outside src/verticals/

npm --prefix apps/crm-shell install && npm run app:ui   # build the app frontend once
npm run app -- <build-name> [port]                      # run a built business as its own app (default :8801)
```

Tests are plain scripts, no framework: each file defines a local `check(label, cond)`, prints PASS/FAIL, and `process.exit(1)` on failure. A new test file must be added to the `test:domain` chain in `package.json` or it won't run. Tests need no network, keys, or database.

The server **refuses to start** without `SHIPMATE_API_SECRET` (see `.env.example`). Every route except `/health` requires header `x-shipmate-secret`.

## Architecture

- `src/verticals/` — the business-specific data the kernel runs on. Eleven configs (`freight.ts`, `dental.ts`, `legal.ts`, `gym.ts`, …); `all.ts` lists them for the registry and the tests, `active.ts` picks the one this deployment runs; `defineVertical()` makes typos in `next`/actions compile errors; `validate.ts` repeats those checks at runtime for JSON configs. Change states or policy here, never in the kernel — `vertical.test.ts` fails if `twin.ts`/`policy.ts` name a state or action, and validates every shipped vertical, not just the active one.
- `src/domain/` — pure logic, no I/O. `commitment.ts` (IST deadlines, dependency chains, evidence required to resolve), `twin.ts` (`can()` = is this action legal in this state; states come from the active vertical), `policy.ts` (`decide()` = may SHIPMATE act alone or does a human approve). `can()` and `decide()` are deliberately separate questions and both must pass.
- `src/engines/` — `auditLedger.ts`: `record()` takes the action as a callback and runs it, so no action happens without a ledger entry; reversal appends, never deletes. `store.ts`: in-memory `Map`s behind an interface — the seam for real persistence; nothing else may know how storage works. `cutoffSentinel.ts` sweeps open commitments and escalates at most once each. `callIntake.ts` (Claude) and `emailIntake.ts` (Gemini) extract commitments; `rfq.ts`, `margin.ts`, `partners.ts`, `riskEngine.ts` run the quoting pipeline.
- `src/memory/cognee.ts` — **degrades to empty and never throws**; a memory outage must not block a shipment.
- `src/adapters/crmV1.ts` — PostgREST against v1 Supabase with the service-role key. **Throws on failure, deliberately** — the opposite of cognee, because silently dropping a commitment/RFQ is worse than erroring.
- `src/http/server.ts` — Express 5; handlers wrapped with `wrap()` for async errors; `param()` normalises Express 5's `string | string[]` params.
- `n8n/` — five importable workflows. n8n keys `connections` by node *name*, so renames can silently drop edges — always run `check:workflows`. Files keep `{{ $env.SHIPMATE_BASE }}`; `scripts/lib/substitute.mjs` bakes literals in at deploy time because n8n Cloud restricts `$env` and gates `$vars`.

## The builder (`src/builder/`)

Two modes, one model call each, both on free models:
- **Fork** (`fork.ts` → `blueprint.ts` → `forkRun.ts`): a new business built from whichever template `pick()` routes the request to. The model is given a compact digest of the live template and returns only a delta (states, actions, column renames/drops/adds, which agents and workflows to keep). `normalise()` fixes mechanical slips in code; `checkFork()` rejects the rest (one repair call max). Everything after that — SQL, cloned n8n JSON, agent prompts, `vertical.ts` — is generated deterministically. Approval writes files to `builds/<id>-<hash>/` and nothing else. Drafts are cached in `builds/.cache/`; bump `PROMPT_VERSION` when the prompt changes.
- **Extend** (`spec.ts` → `manifest.ts` → `gap.ts` → `plan.ts`, driven by `orchestrator.ts`): a change to this system, diffed against the live manifest. Stops at approval; no executor.

- **Compose** (`composeRun.ts`, the page's default "New business"): the module catalogue path (`src/modules/`). Runs mirror fork runs (polled via `/api/runs/:id`, `REQUEST_RECEIVED → DRAFTING → CLARIFICATION_REQUIRED | WAITING_FOR_APPROVAL → APPROVED → BUILT`, or `FAILED`), plus `/api/compose/:id/config`: the page edits the config and it is recomposed in code at zero tokens (a FAILED draft is fixed this way). `/api/compose/example` and `/api/compose/from-config` start runs with no model. `composeView()`/`summarise()` put a composition in the page's terms. The page side is `web/builder/compose.js` (loaded before `app.js`, called only from its render/mode/boot hooks); fork mode is now the "From the freight template" tab.
- `/api/builds/:name` never returns what a running app keeps in its build folder — dotfiles (`.app-secret`, `.mcp-secret`), `data/`, `agent-runs/`, `runtime.json`, logs (`NOT_THE_BUILD` in web.ts); the builder can be opened to a network or hosted.

`router.ts` sends every model call to Kilo Code's gateway (`KILO_API_KEY`), walking a ladder of free models with reasoning disabled; `BUILDER_GATEWAY=omniroute` switches to a local OmniRoute. The paid Anthropic path runs only with `BUILDER_ALLOW_PAID_FALLBACK=1`. `web.ts` serves `web/builder/` (plain HTML/JS, no build step) on 127.0.0.1 only, rejects non-localhost Host headers and non-JSON POSTs — keep it off public interfaces, it holds the service-role key. The one exception is `--lan` (`access.ts`, shared with the app runtime): it binds all interfaces, still rejects Hosts that are not this machine, and requires the access key (query once, then an HttpOnly cookie) from every non-loopback caller. Apps launched from a LAN-mode builder inherit the mode and key.

## The module catalogue (`src/modules/`) — composed apps

The successor to fork mode's table cloning; see `docs/MODULES.md`. 26 generic modules (contacts, pipeline, quotes, invoicing, payments, memberships, appointments, capacity, inventory, claims, messaging, …) in `catalog/`, each pure data via `defineModule()`: entities with fixed field names, lifecycles, actions (effects, default policy, `when`/`to`, `guard`, `sets`, `creates`, `measure`), settings. A business is a `config.json` (`config.ts`) that picks modules and may only relabel, drop optional fields, add fields, replace options, turn actions off, change policies/thresholds and settings — plus, for the extensible `pipeline` only, its own lifecycle and `customActions`. Identifiers never change, so action names are stable tool names.

- `formula.ts` — the only logic modules carry: a hand-written parser (no eval) for computed fields, guards, automatic moves and written values (`sum(payment.amount, state = 'received')`, `add_days(today(), setting.payment_terms_days)`).
- `compose.ts` — config → `ComposedApp`. Normalises one-answer slips with notes (adds required modules, keeps fields the logic reads, gives a custom threshold an `amount` param) and reports everything else as problems by name; resolves every formula name against the composed entities. `draft.ts` is the model's half (digest of the catalogue + rules, one repair call, cached in `builds/.cache`).
- Model answers are read with `jsonRepair.ts` `parseLenient()` (draft and agent): comments, trailing commas, stray or missing brackets — of two readings of a stray closer, the one needing fewer fixes wins. `compose()` first hoists keys written a level too deep (`lifecycle`/`actions`/`settings`/`customActions` inside `entities`; `primary`/`vocabulary`/`openQuestions` inside a module). Both measured on live drafts; each fix becomes a note. The prompt's SHAPE is laid out with each module's own properties on separate lines (`layout()` in draft.ts) — compact made brackets slip, fully pretty-printed doubled output tokens.
- `manifest.ts` → `app.json` **version 2** (`AppManifest` with `modules`, `actions`, per-entity `lifecycle`/`stageColumn`); `machineFor()` builds each entity's `VerticalConfig` so the unchanged kernel runs invoices, memberships, the clinic's own stages alike.
- `engine.ts` — `ModuleEngine`: legality (`machine.can`) → guard → policy (`decideFor`) → perform (creates, sets, move), then recomputes formulas up through refs and applies automatic moves. Only the pipeline's entity is moved by hand. Once the staff list names approvers, approvals need the matching role (or `owner`). `routes.ts` mounts it in `app-runtime/app.ts` when `app.json` is version 2; v1 builds keep the original engine and routes.
- `npm run compose -- "<business>" | --example <name> | --config <file>` writes `builds/<id>-<hash>/{config.json, app.json, schema.sql, BUILD.md}`. Examples (`examples/*.json`) are the shape a model's answer takes and are composed and run by `modules.test.ts`/`engine.test.ts`.
- Adding a module: one file in `catalog/`, listed in `catalog/index.ts`; entity and action names unique across the catalogue; `modules.test.ts` composes it with every other module.

## The agent, its MCP server and ArmorIQ (`src/mcp/`, `src/agent/`) — see `docs/ARMORIQ.md`

- `mcp/tools.ts` generates a composed build's tools from app.json (`find_records`, `get_record`, `create_<entity>`, one per action under its catalogue name); the MCP server, the agent and the policy compiler all read this one list. `mcp/server.ts` serves them at `POST /mcp` inside the running app (same engine, same data — never a second process on the same JSON store): JSON-RPC 2.0, answers as SSE (ArmorIQ's required format), bearer token from `builds/<build>/.mcp-secret`, constant-time compare. Calls are ledgered as `<name> (agent)`.
- `agent/agent.ts` — plan per turn as JSON `{thought, calls, done}` → `guard.declare` → `guard.check` each call → MCP → `guard.report`. Context text is fenced as `<data>`. An `id`/`*_id` argument must have been seen (task, context, earlier result) or the call is not run — measured: the model guessed an appointment id on its first live run. Guard errors block (fail closed).
- `agent/guard.ts` — `ArmorIQGuard` (`@armoriq/sdk`, session `mode: "sdk"`, bare action names with `defaultMcpName`; the SDK itself blocks calls not in the declared plan) and `UnguardedGuard` (offline only; the CLI and the app refuse to use it unless asked explicitly). `agent/policy.ts` compiles the agent's policy: allow reads/creates/ordinary actions, block `sensitive`/`destructive` effects and the staff module, default block; writes `armoriq/{policy.yaml, armoriq.yaml, AGENT-RULES.md}` into every build. Kernel approvals stay in the app's queue (not duplicated at ArmorIQ).
- `npm run agent -- <build> "<task>" [--context file] [--unguarded]`, `npm run agent -- --policy <build>`; the app's Agent page (`/agent`, `agent/routes.ts`) runs the same thing in-process via `inProcessTools`. Runs are saved to `builds/<build>/agent-runs/*.json`.
- `router.ts` skips Kilo ladder rungs the gateway does not currently list as free (they lose the tier silently and are then billed).

## Built apps (`src/app-runtime/`, `apps/crm-shell/`)

Every fork build writes `app.json` (from `src/builder/appManifest.ts`): each table's role comes from the template table it was cloned from (real_records → primary/lifecycle, enquiry_events → events, space_slots → slots, partners → partners…), plus title/stage columns, cross-table links, and `leftover` flags on freight columns the draft carried over. `npm run app -- <build>` serves that build as a standalone app: its own process, port and data (`builds/<name>/data/*.json`, written atomically), and `runtime.json` so the builder can find it. The builder's "Launch app" spawns it detached and only links to it.

- Backend: `engine.ts` runs the kernel via `domain/machine.ts` + `decideFor()` on the build's vertical — the same state machine and policy gate as freight (twin.ts/policy.ts delegate to the same code). Held actions go to an approvals queue; the requester cannot approve their own; approval re-checks legality. Every write needs a desk-user name (`x-desk-user`) and lands in the append-only ledger.
- `app.ts` is the app as a mountable Express app; `server.ts` listens with it on its own port, and a `--public` builder mounts it at `/apps/<build>/` instead (one public port on a host). The page learns its path from `<base href>` (written by the server), which the shell uses for API calls, the router and assets (`vite base: "./"`).
- Frontend: `apps/crm-shell` is the React/Vite/Tailwind shell every built app renders through (layout, theme, MetricCard, StatusPill, RowCard, PageHeader, Brand, the StageAction/Timeline patterns), with every page driven by `/api/app`. It has its own `package.json`; rebuild with `npm run app:ui` after editing it.

## Deploying a build (`src/builder/deploy.ts`, `deployContent.ts`, `agentNames.ts`)

`deploy.ts` pushes a build to the live, **shared** accounts through their APIs: a Cognee dataset of its own (seeded with prose about the business, then cognified), SnapServe knowledge sources (created with content inline — an empty source stays "failed") and draft agents cloned from the template's voice setup, and an n8n credential (`x-app-key`) plus the workflows, switched off. The record is `builds/<name>/deploy.json`.

- Isolation is the rule: everything is named `[<build name>]`, and an update or delete needs both the id in that build's record and the namespaced name read back live. Never write to Priya (717), Arun (758), the SHIPMATE workflows, `araxys_shipments`, or anything another build made. `deploy.test.ts` pins this with fakes of all three services.
- Agents never reuse a name any other agent on the account has: `fork.ts` renames template names at draft time, and `deploy.ts` renames against the live account (rewriting app.json, prompt, greeting and agent files) before creating. Build agents get `voiceMemoryEnabled: false` — caller memory belongs to the host CRM, not to a build. SnapServe drops `dispositionSchema` on create, so it is PATCHed after.
- Never activates workflows or gives agents a phone number or webhook. Going live needs the app at a public https URL (n8n Cloud can't reach a laptop; no tunnels).
- The running app (`app-runtime/live.ts`) writes every ledger entry to its Cognee dataset, answers `/api/memory/ask`, rebuilds its "reference data" knowledge source when slots/partners change (sample rows excluded via the ledger), and exposes `/calls/ingest`, `/sentinel/sweep`, `/memory/cognify` to its n8n workflows behind `x-app-key` (`builds/<name>/.app-secret`).

## Model choices

`CLAUDE_MODEL` (call extraction) defaults to Opus because smaller models misread quoted rates on real Tamil/English calls — read the note in `callIntake.ts` before changing it. `GEMINI_MODEL` is used for email.

## Do not

- Add CORS to `server.ts` — nothing in a browser should reach this API.
- Weaken auth to an `if (expected && ...)` pattern; it must fail closed.
- Let a commitment be fulfilled without evidence — `resolve()` throws and the route's 400 mirrors it.
- Wire agents or n8n to tunnel/localhost URLs (`trycloudflare.com` etc.); SHIPMATE must be publicly hosted (`render.yaml`, `Dockerfile`) for n8n Cloud to reach it.
- Run the old one-shot scripts in `araxys-crm/scripts/` — they PUT whole agent payloads and overwrite prompts. `wire-agent-webhook.mjs` patches only `webhookUrl`.
- Treat the Paytm callback (`n8n/03-money-rail.json`) as safe: it does not verify Paytm's checksum yet.

`docs/ORCHESTRATION-AGENT-PLAN.md` is the plan the builder follows. Steps 1 and 2 (extract to config, then hand-write further verticals) are done for the lifecycle and policy; call/mail extraction and the risk engine still carry freight-specific code — `npm run residue` reports what is left.
