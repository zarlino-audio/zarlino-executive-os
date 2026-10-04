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

**Current path (2026-10-04):** download **ZarlinoVM-Setup-<ver>.exe** from the OS console
(`os.zarlinoaudio.com` -> Ops -> Files -> "Machine setup (VM)"), or fetch it from the
artifact API (`GET /api/artifacts?prefix=artifacts/vm-setup/`). Run it as Administrator
inside the new host and paste the founder token. Source + build:
`company-readiness/vm-setup/` in the plugin repo (`build-vm-setup.ps1 -Version X -Publish`).
It installs Node, pulls the executor + bridge payload from the OS, writes config, registers
auto-start and verifies the heartbeat.

*Legacy path (kept for reference):* `ZarlinoInstanceSetup.exe` from
<https://zarlinoaudio.com/instance/> ran `instance-provision.ps1`, which cloned the repo with
git instead of pulling a payload from the OS. Superseded by the VM kit above.

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

- The Azure VM (`Zarlino1.rdp` -> 102.37.153.164) is the always-on host as of 2026-10-04.
- `remote-provision.ps1` is legacy (daemon-only); `instance-provision.ps1` is the legacy kit
  behind the old EXE.

## 2026-10-04 - retirement executed (DESKTOP-CO8JM8O -> Zarlino1)

Sequence actually run, with evidence:

1. **Replacement verified first.** Doctor showed `whatsapp.bridge: Bridge alive on Zarlino1
   (...) last heartbeat 7s ago` - the VM had already been provisioned and paired.
2. **Channel moved, proven by draining with the old host dark.** This machine's bridge was
   stopped (port 3037 no longer listening), then a founder notification was queued via
   `POST /api/notify/founder`. It flipped `QUEUED_UNCONFIGURED -> SENT` inside 50s, which only
   the VM bridge could have done. (The founder receives that message on WhatsApp.)
3. **This machine retired.** `scripts/retire-this-machine.ps1 -Execute -Deregister` stopped the
   daemon, removed both startup entries and deregistered `local_daemon_01`. No node processes
   remain; only `Ollama.lnk` is left in Startup.

Leftover items (human, all optional):

| Item | Action |
|---|---|
| Stale WhatsApp linked device from the laptop | On the business phone: WhatsApp -> Linked devices -> remove the old entry |
| `Zarlino Nightly Backup` task (02:30) still exists on the laptop | Keep it while the machine is in use (protects the worktree); delete it if the machine is wiped |
| Local `.dev.vars` + `tools/whatsapp-bridge/auth/` on the laptop | Live credentials. Keep, or wipe if the machine leaves the founder's control |
| Build/rendering capability | Still laptop-only (no VS/Ninja toolchain on the VM); the VM executor handles non-build tasks |
