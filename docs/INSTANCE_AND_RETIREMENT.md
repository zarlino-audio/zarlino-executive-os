# Instance Kit & Machine Retirement (2026-10-02)

The Executive OS lives in the cloud (Cloudflare DO + cron + Workers AI executive
tier + DeepSeek heavy tier + R2 + GitHub). A **machine** is needed for exactly
two jobs:

| Job | What it does | Where it can run |
|---|---|---|
| Daemon (`scripts/local-daemon.ts`) | claims local tasks (builds, renders, FL Studio) from the cloud queue | any Windows machine |
| WhatsApp bridge (`tools/whatsapp-bridge`) | links the business WhatsApp (linked device) for founder escalations + replies | any always-on Windows machine |

Neither is a single point of failure once a machine hosts them — and any machine
can become that host in ~5 minutes with the instance kit below.

## One-click instance from any machine

1. Download **ZarlinoInstanceSetup.exe** from <https://zarlinoaudio.com/instance/>
   (or copy `tools/instance-setup/ZarlinoInstanceSetup.exe`).
2. Run it. It fetches the current provisioner and runs it:
   - installs git/node if missing (winget)
   - clones `zarlino-executive-os` into `C:\Zarlino\zarlino-executive-os`
   - asks for `DEEPSEEK_API_KEY` + `FOUNDER_AUTH_TOKEN` (typed on that machine,
     stored in gitignored `.dev.vars`)
   - installs the daemon launcher (restart-loop + auto-start at login)
   - installs the WhatsApp bridge (restart-loop + auto-start), optionally with
     an imported session (see below)
   - registers the machine as its own instance id (`remote_daemon_01` default)
   - verifies the daemon + bridge heartbeats against the cloud

Options: `-CheckOnly` (preview, changes nothing), `-AgentId ws_studio_02`,
`-CloneWorkspace` (plugins repo for builds), `-NoBridge`, `-NoStart`,
`-BridgeSessionZip <zip>`, `-Yes` (non-interactive).

## Moving the WhatsApp channel WITHOUT a QR scan

The linked-device session lives in `tools/whatsapp-bridge/auth/` on whichever
machine hosts the bridge:

1. On the current host: `scripts/export-bridge-session.ps1` →
   `Desktop\zarlino-whatsapp-session-<date>.zip` (live credentials — treat like
   a password; transfer privately, delete after import).
2. On the new machine: `instance-provision.ps1 -BridgeSessionZip <zip>`.
3. The bridge reconnects as the same linked device — **no QR scan needed**.

If no session zip is available, the bridge serves a QR at
`http://localhost:3037/` on the new host instead.

## Retirement procedure (this laptop → any host)

Verify the replacement FIRST (all three):

- `GET /api/org/agents` shows the new instance with fresh `last_seen`
- `GET /api/whatsapp/bridge` shows `fresh: true` (doctor `whatsapp.bridge` = OK)
- one WhatsApp round-trip works (message the business number → reply arrives)

Then retire the old machine:

```powershell
cd <exec-os>\scripts
.\retire-this-machine.ps1                    # dry run — prints the plan
.\retire-this-machine.ps1 -Execute -Deregister
```

That stops the daemon + bridge, removes their startup entries, and removes the
instance from the org registry. The cloud keeps running: CEO cycles on cron,
escalations queue in the cloud and deliver the moment any bridge host links.

## Cloud-only scorecard (what depends on a machine today)

| Capability | Runs | After retirement |
|---|---|---|
| Brain / state / approvals / CEO cycles | Cloudflare DO + cron | unchanged (cloud) |
| Executive model calls | Workers AI high tier (10k neurons/day) | unchanged (cloud) |
| Heavy agent runs / code | DeepSeek, executed in the DO | unchanged (cloud) |
| Founder channel (WhatsApp) | bridge on a machine | moves to the replacement host (session import, no QR) |
| Local tasks (build/render/FL) | daemon on a machine | move to the replacement host; queue waits if none |
| Console / MCP (read-only) | Cloudflare | unchanged (cloud) |

## Notes

- The Azure VM (`Zarlino1.rdp` → 102.37.153.164) is the intended always-on
  host; as of 2026-10-02 it is deallocated — **start it in the Azure portal
  before running the EXE on it**.
- `remote-provision.ps1` is legacy (daemon-only); `instance-provision.ps1` is
  the canonical kit and what the EXE runs.
