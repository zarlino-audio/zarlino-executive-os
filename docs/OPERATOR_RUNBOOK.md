# Zarlino Executive OS — Operator Runbook

> For the person running the company from anywhere, with **no access to the dev
> machine**. Everything here works from the web console and the cloud agent.

## 0. What this is

A self-running company: a cloud agent (DeepSeek) that thinks, plans, files
approvals, does web/GitHub/website/Cloudflare work, and produces **sound and UI
artifacts for YOU to vet** — plus a web console where you decide. Your job is
**oversight and taste**: approve/reject sound and UI, decide what ships, and
steer via chat.

## 1. Sign in

- Open `https://zarlino-executive-os.zarlino001.workers.dev`
- Username **Khritical** / temporary password **0000**
- **Change the password immediately** in ⚙️ Settings → Change password.
- The session lasts 30 days; if it expires you'll be bounced to sign-in.

## 2. Your daily loop (15 minutes)

1. **🏠 Overview** — read the **🎯 Needs the Founder** digest: overdue reminders,
   pending approvals, open contradictions, top risks, and **reviews to vet**.
2. **🎧 Reviews** — the most important screen. The Executive files reviews when
   it produces **sound** (A/B comparisons you must *listen* to) or **UI** (you
   must *look* at). Play A and B, then **✅ Approve**, **🔁 Needs work**, or
   **❌ Reject** with a note. Your verdict is audited and feeds the agent.
3. **✋ Approvals** — approve/reject decisions (money moves, deploys, policy).
4. **💬 Chat** — ask anything: "daily brief", "what did you work on", "make the
   low end tighter and re-render the A/B", "file a sound review".
5. **🩺 System Doctor** — watch the 18 health checks. If something is FAIL, the
   detail tells you exactly what and what to do.

## 3. Ordering work

- **Chat** is the fastest way: describe what you want in plain language. The
  agent turns it into tasks and does the work it can do from the cloud.
- **✅ Tasks** — create tasks directly; the agent auto-runs eligible ones
  (🤖 auto-run), bounded by the AI spend budget.
- **Local machine work** (building plugins, FL Studio launch tests, rendering
  A/B audio from the repo) requires the dev daemon. If it's offline you'll see
  it in 🖥️ Local & Runs and the doctor will flag `local_agent.health`. Cloud
  work (research, website, GitHub, finance, drafting, docs, UI reports) always
  works.

## 4. Vetting sound & UI (not just decisions)

This is the core of quality control — the Executive must never ship sound or UI
you haven't heard or seen:

- **Sound**: when a render/A-B is produced, a **sound review** appears in 🎧
  Reviews with two players (A = reference, B = candidate). Listen on good
  headphones. Approve the side that's right, or ask for work with a note like
  "B is harsh in the top end, tame 4-6 kHz and re-render".
- **UI**: a **UI review** shows the screenshot (or the inspection report).
  Verify layout, labels, and that it matches the spec before approving.
- Reviews are **audited**: who decided, when, and the note are stored and shown.
- You can also file a review yourself (e.g. "vet this release note") from the
  🎧 Reviews view.

## 5. Decisions vs Reviews vs Approvals

| Surface | What | Where |
|---|---|---|
| **Reviews** | Sound/UI/artifact quality — *hear and see* | 🎧 Reviews |
| **Approvals** | Action decisions (spend, deploy, policy) | ✋ Approvals |
| **Contradictions** | Conflicting facts/misconceptions to resolve | ⚡ Productivity |
| **Risks** | Open risks with mitigation | 🧭 Decisions & Risks |

## 6. Money & budget

- ⚙️ Settings → Budget overrides: set daily/monthly AI spend caps. They apply
  immediately (the Overview fuel gauges reflect the *effective* caps).
- 💰 Finance shows cash/revenue/expenses/runway. "—" means the value is unknown
  (not zero).
- If the agent starts failing with **HTTP 402**, the DeepSeek account is out of
  balance — top it up at platform.deepseek.com; the Doctor will tell you.

## 7. When the agent gets stuck

- **Chat**: ask it to continue or rephrase.
- **🖥️ Local & Runs**: any FAILED/STOPPED long-horizon run has a **Continue**
  button — it resumes from its checkpoint automatically.
- **🩺 Doctor** auto-fixes safe issues (stale runs, expired leases, migrations)
  and tells you what needs *your* judgment.

## 8. Production reset (fresh start)

`POST /api/system/reset-production` with `{"confirm":"RESET PRODUCTION"}` (via
the API) archives all active tasks, resets pipeline gates to NOT_STARTED,
products to CONCEPT, and cancels in-flight local work — **nothing is deleted**,
and a full backup snapshot is returned. Prefer doing this deliberately, after a
backup.

## 9. Security

- Change the founder password (step 1). All sessions are revoked on change.
- Control toggles on 🏠 Overview (pause executive, disable spending, disable
  deploys, full access) are **confirmed before they fire** — use them to stop
  the machine instantly if needed.
- Secrets (DeepSeek key, GitHub/Cloudflare tokens) live in the worker, never in
  the console.
