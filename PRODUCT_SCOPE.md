# PRODUCT_SCOPE.md

What Cola is, who it serves, and the guardrails that keep new work on-product.

Current as of 2026-05. Read alongside `AGENTS.md` §1–2 (the canonical definition) and `ROADMAP.md` (what's being built now). If this file disagrees with `AGENTS.md`, `AGENTS.md` wins.

---

## 1. What Cola is

Cola is an **agentic operating system for U.S. real estate agents and companies.**

A seller's book of business — contacts, leads, deals, demos, products, applications — is the workspace. Cola is an autonomous AI agent that works *inside* that workspace on the seller's behalf: it qualifies inbound leads, drafts and sends follow-up, schedules demos, advances deals, produces marketing content, and surfaces what needs attention — taking sign-off only where a human decision is genuinely required.

**The product is the agent.** The CRM-style data structures underneath it — contacts, deals, pipelines — are *substrate, not the product*. Cola is not a database the seller maintains; it is an operator that maintains it for them. It runs two ways:

- **On request** — the seller talks to Cola in chat; it does the job and reports back.
- **On its own** — workspace events (new lead, application submitted, demo completed, deal stage change, inbound message) and scheduled sweeps wake Cola to act in near real-time, without being asked.

Two principles follow, and they govern every scope decision:

1. **New work should make Cola do more on the user's behalf** — not add a surface the user operates themselves.
2. **A configuration screen is a last resort.** "We'll add a setting" usually means the agent didn't do its job. Decide it, or teach the agent to.

---

## 2. Who it serves

- **Solo and independent sellers** — Cola runs the lead pipeline end to end.
- **Companies** — manager owners and admins oversee a team of agents: lead routing, commissions, deal review, performance. The company tier is *part of one product*, not a separate one — an operating system for real estate spans the individual agent and the firm they belong to.
- **Manager-only users** — oversee a team without running a personal lead workspace.

---

## 3. The launch wedge — the way in, not the ceiling

The product is broad. The **go-to-market entry point is deliberately narrow.** The wedge is how Cola lands a first user and proves itself fast; it is not a cap on what Cola is.

- **Who**: new solo sellers in the U.S.
- **What**: renter and leasing lead qualification
- **Why this wedge**: it's the shortest path to a seller *feeling* the agent do real work — minimal setup, one shareable intake link, an explainable score, follow-up that happens without being asked
- **Activation event**: intake link generated
- **Retention signal**: applications flowing in, and the seller returning to act on what Cola surfaced

"Protect the wedge" means: keep the **first-run experience** fast and unsprawled — sign-up to live intake link stays minimal. It does **not** mean the product stops at renter leads. Depth elsewhere is welcome; friction on a new seller's path to first value is not.

---

## 4. What Cola does today

A capability snapshot — categorical, not exhaustive. For the live surface map see `ARCHITECTURE.md` and `README.md`.

- **Autonomous agent** — chat plus event-triggered background runs; tool-use across the whole workspace; every mutation is approval-gated; Cola drafts, it never sends silently
- **Public intake** — branded, customizable, conversational application pages; separate rental and buyer flows
- **Explainable lead scoring** — every lead gets a score, a hot/warm/cold label, and a plain-language reason
- **Lead → contact → deal pipeline** — the CRM substrate, with customizable stages
- **Demos** — scheduling, public booking pages, calendar sync, reminders, post-demo feedback
- **Products** — listings and shareable product packets
- **Company tier** — team roster, invitations, lead routing, commission ledger, deal review, leaderboards, audit log
- **Studio** — AI image and video generation, brand kit, social-post composer, scheduling and publishing
- **Integrations** — connected toolkits (Gmail, HubSpot, Slack, Google Calendar) become agent tools; Cola is also exposed as an MCP server
- **Notifications** — email and SMS for leads, demos, deals, follow-ups
- **Analytics** — pipeline, leads, demos, form traffic, team performance
- **Files & documents** — uploads and an in-app document editor
- **Billing** — per-seat company subscriptions are in place; usage-based agent metering is in progress (see `ROADMAP.md`)

---

## 5. Scope guardrails — on-product vs. off-product

Earlier versions of this file kept a list of *forbidden features*. Feature lists rot — several "out of scope" items (team accounts, SMS, marketing tools) shipped, and the doc went stale and started misdirecting. Judge new work by **principle** instead.

**On-product** — the change:

- makes the agent do more of the seller's work, or do it better
- removes a step the human currently does by hand
- deepens a surface that already exists

**Off-product** — the change:

- adds a setting, toggle, or config surface the seller must operate themselves — the agent should decide, or learn the preference
- expands toward generic all-in-one CRM breadth that doesn't route through the agent
- ships AI output that isn't explainable or actionable
- adds friction to the sign-up → live intake link path

The test, when unsure: *does this make Cola more of an operator, or more of a tool the seller operates?* Operator wins.

Note for AI coding agents: this section describes *product* scope. It does not loosen `AGENTS.md` §3 and §8 — you still never build a feature without explicit instruction, on-product or not.

---

## 6. Anti-goals

1. Don't drift toward a generic CRM dashboard the seller babysits. The agent does the work.
2. Don't ship "AI magic" without explainability — every AI output is practical and transparent.
3. Don't add setup friction. First-run stays minimal.
4. Don't solve with a setting what the agent could decide or learn.
5. Don't optimize vanity metrics (sign-ups, page views) over activation (intake link generated, applications received, agent actions taken).
6. Don't let breadth degrade the wedge's first-run experience.

---

## 7. What success looks like

- **Setup**: sign-up to live intake link in minutes, not a configuration project
- **Activation**: intake link generated
- **The agent earns trust**: Cola takes real actions — scored leads, drafted follow-up, booked demos — and the seller sees and approves them
- **Retention**: the seller returns to act on what Cola surfaced, and lets it do more over time
- **Company**: managers run team oversight — routing, commissions, review — through Cola rather than spreadsheets
