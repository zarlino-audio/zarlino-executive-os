# Remote Dev Machine (Zarlino1 RDP box)

The remote machine (`Zarlino1.rdp` → `102.37.153.164:3389`, user `Zarlino`) is the
**second physical runtime** of the artificial organization: an always-on
instance for local-capability execution (builds, renders, FL Studio launches)
that keeps working when the founder's laptop is off.

The cloud Worker (Durable Object) stays on Cloudflare — it is already reliable.
The remote machine provides a reliable **local-capability instance**.

## Architecture after migration

```
Cloudflare (always on)                 Remote machine (always on)
────────────────────────               ──────────────────────────
Executive OS Worker                    scripts/local-daemon.ts
  DO (executive_do_01 = COA role)        AGENT_ID=remote_daemon_01
  + SQLite org registry                  role_software_engineering
                                   ↕ heartbeats every 30s ↕
```

Each daemon registers under its own honest instance id (§7): the founder
machine is `local_daemon_01`, this machine is `remote_daemon_01`. Both claim
from the same local-task queue with leases.

## Provisioning (one-time, on the remote machine)

0. **Start the VM first.** As of 2026-09-29 the box does NOT answer on
   `102.37.153.164:3389` (the Azure VM appears deallocated — deallocation
   stops billing but also stops the box; start it in the Azure portal and
   re-test before RDP).
1. Power on the machine and RDP in (credentials prompt on connect).
2. Copy `scripts/remote-provision.ps1` from this repo to the remote desktop
   (drag-and-drop over RDP works).
3. Open PowerShell and run:

   ```powershell
   cd $env:USERPROFILE\Desktop
   .\remote-provision.ps1 -CloneWorkspace
   ```

   Notes:
   - The provisioner does a **FULL `npm ci`** and verifies `tsx` afterwards:
     the daemon runs through `tsx` (a devDependency), so an `--omit=dev`
     install would leave `npm run agent:daemon:loop` unable to start.
   - Website tools from the box additionally need the website repo cloned
     INSIDE the workspace clone: `C:\Zarlino\Zarlino\zarlino-website`
     (`git clone https://github.com/zarlino-audio/zarlino-website` there).
   - Until VS/CMake/Python/FL Studio are installed on the box, build/render
     local tools will report honest failures — the daemon itself works.

   `-CloneWorkspace` also clones the Zarlino plugins repo so build/render
   local tools work. You will be prompted for:
   - GitHub credentials (private repo),
   - `DEEPSEEK_API_KEY` and `FOUNDER_AUTH_TOKEN` — typed directly on the
     remote machine; they are written to `.dev.vars` (gitignored) and never
     printed or transmitted elsewhere.

The script installs git/node if missing, clones the OS repo, installs
dependencies, registers `remote_daemon_01` in the org registry, and installs
a startup launcher so the daemon survives reboots.

## Verification

On the OS console (or via API):

- `GET /api/org/agents` shows `remote_daemon_01` with fresh `last_seen`
  (also `local_daemon_01` from the founder machine).
- The remote daemon claims the oldest PENDING local task every ~30s.
- Doctor `org.registry` stays OK while both instances heartbeat.

Notes:

- Doctor `local_agent.health` follows the **freshest heartbeat** across all
  daemon instances; per-instance liveness is tracked via `org_agents` +
  `org.registry`.
- `local_tasks` are claimed first-come; leases prevent double execution.
- Machine-specific tool paths in `scripts/local-agent.ts` (VS `vcvars64.bat`,
  FL Studio, Python scripts dir) may need adjusting on this machine — after
  provisioning, run one small local task and verify tool resolution.
- Deregister a dead instance with `DELETE /api/org/agents/:id`.
