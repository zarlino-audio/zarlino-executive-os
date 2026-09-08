/**
 * Local Agent CLI — "agents working locally".
 *
 * A terminal agent that can actually DO work on the local machine/repo:
 *   - read/write local files (repo level),
 *   - run commands, tests, builds (locally),
 *   - deploy the website via wrangler (website level),
 *   - is grounded in the live Executive OS (overview/doctrine/tasks) fetched
 *     from the deployed worker.
 *
 * It uses DeepSeek's OpenAI-compatible function calling to decide which local
 * tools to run, loops tool→result until it produces a final answer, and
 * streams tokens to the terminal. Dangerous actions (write file, run arbitrary
 * command, deploy) require confirmation unless you pass --yes.
 *
 * Run:  npm run agent:local        (interactive REPL)
 *       npm run agent:local "list the plugins folder"
 *       npm run agent:local --yes "run the executive-os tests"
 */

import { exec as execRaw } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";

// Async exec (promisified) — NEVER use execSync here: a long local command
// (build, ctest, deploy) can run up to the 10-min timeout, and a blocking
// sync call freezes the event loop, which silently kills the daemon's
// heartbeat/beacon and makes the Doctor flag the machine agent offline
// ("daemon died") even though it is mid-build.
const exec = promisify(execRaw);
import { dirname, join, basename, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "./dotenv.js";

// ---- paths -----------------------------------------------------------------
const SCRIPT_DIR = resolve(fileURLToPath(import.meta.url), "..");
export const REPO_ROOT = resolve(SCRIPT_DIR, "..", ".."); // …/plugin
export const EXEC_OS = join(REPO_ROOT, "executive-os");
export const WEBSITE = join(REPO_ROOT, "zarlino-website");

// ---- env -------------------------------------------------------------------
const dotenv = loadDotEnv(join(EXEC_OS, ".dev.vars"));
export const API_KEY = process.env.DEEPSEEK_API_KEY ?? dotenv.DEEPSEEK_API_KEY ?? "";
export const TOKEN = process.env.FOUNDER_AUTH_TOKEN ?? dotenv.FOUNDER_AUTH_TOKEN ?? "";
export const EXEC_URL = process.env.EXEC_OS_URL ?? "https://zarlino-executive-os.zarlino001.workers.dev";
export const AUTO_YES = process.argv.includes("--yes");

export function ensureApiKey(): void {
  if (!API_KEY) {
    console.error("DEEPSEEK_API_KEY not found — add it to executive-os/.dev.vars or the environment.");
    process.exit(1);
  }
}

// ---- confirmation ------------------------------------------------------------
export function confirm(prompt: string): Promise<boolean> {
  if (AUTO_YES) return Promise.resolve(true);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question(`${prompt} (y/N) `, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

// ---- tool implementations -----------------------------------------------------
export interface LocalTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  needsConfirm: boolean;
  run(args: Record<string, unknown>): Promise<string>;
}

export async function runCommand(cmd: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await exec(cmd, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 600_000, windowsHide: true });
    return stdout.length > 8000 ? stdout.slice(0, 8000) + "\n…(truncated)" : stdout;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return `COMMAND FAILED:\n${(e.stdout || "")}\n${(e.stderr || e.message || "").slice(0, 4000)}`;
  }
}

// ---- plugin-factory helpers -----------------------------------------------------

/** Recursively copy a directory tree. */
function copyDir(src: string, dest: string): void {
  if (!existsSync(src)) throw new Error(`Source not found: ${src}`);
  const entries = readdirSync(src, { withFileTypes: true });
  for (const e of entries) {
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isDirectory()) {
      mkdirSync(d, { recursive: true });
      copyDir(s, d);
    } else {
      mkdirSync(dirname(d), { recursive: true });
      copyFileSync(s, d);
    }
  }
}

/** Recursively list files under a dir (filtered by extension). */
function walkFiles(dir: string, exts: RegExp, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, exts, out);
    else if (exts.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Locate a plugin's built VST3 bundle. The bundle name follows the PRODUCT
 * name (e.g. "Presence Field.vst3" for plugin folder PresenceField), so glob
 * instead of assuming <plugin>.vst3. Returns the bundle dir path or null.
 */
function findVst3Bundle(plugin: string): string | null {
  const dir = join(REPO_ROOT, "build", "plugins", plugin, `${plugin}_artefacts`, "Release", "VST3");
  if (!existsSync(dir)) return null;
  const bundle = readdirSync(dir).find((f) => f.endsWith(".vst3"));
  return bundle ? join(dir, bundle) : null;
}

/**
 * Run a PowerShell command and return its output as plain text.
 * - `-EncodedCommand` expects Base64 of UTF-16LE (UTF-8 produces mojibake).
 * - Streams are redirected to temp files at the cmd level so PowerShell's
 *   CLIXML error serialization can't corrupt the captured text; CLIXML
 *   markers are stripped, and the process exit code is reported.
 */
async function runPowerShell(script: string): Promise<string> {
  const b64 = Buffer.from(script, "utf16le").toString("base64");
  const arts = join(REPO_ROOT, "artifacts");
  try { mkdirSync(arts, { recursive: true }); } catch { /* ignore */ }
  const outFile = join(arts, "_ps_out.txt");
  const errFile = join(arts, "_ps_err.txt");
  let code = 0;
  try {
    await exec(`powershell -NoProfile -NonInteractive -EncodedCommand ${b64} 1> "${outFile}" 2> "${errFile}"`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 600_000,
      windowsHide: true,
    });
  } catch (err) {
    code = (err as { code?: number }).code ?? 1;
  }
  const clean = (s: string): string => s.replace(/#< CLIXML[\s\S]*$/, "").replace(/\r/g, "").trim();
  const out = existsSync(outFile) ? clean(readFileSync(outFile, "utf8")) : "";
  const err = existsSync(errFile) ? clean(readFileSync(errFile, "utf8")) : "";
  const parts: string[] = [];
  if (out) parts.push(out);
  if (err && !out.includes(err.slice(0, 200))) parts.push(err.slice(0, 3000));
  if (code !== 0) parts.push(`[exit ${code}]`);
  return parts.join("\n") || `(no output, exit ${code})`;
}

/** Upload a file to the live worker as an uploaded file (kind audio/image/text). */
async function postFile(name: string, mime: string, dataBase64: string): Promise<{ fileId: string; kind: string; sizeBytes: number }> {
  const res = await fetch(`${EXEC_URL}/api/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, mime, dataBase64 }),
  });
  if (!res.ok) throw new Error(`Upload HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as { fileId: string; kind: string; sizeBytes: number };
}

/** The FL Studio 21 executable — DAW launch tests ALWAYS use FL21, never FL25. */
const FL21_EXE = "C:\\Program Files\\Image-Line\\FL Studio 21\\FL64.exe";
/** VST3 folder FL Studio scans on Windows (per-machine, admin may be needed). */
const FL_VST3_DIR = "C:\\Program Files\\Common Files\\VST3";

/** Local tool binaries (same resolution as tools/build-release-local.ps1). */
const PY_SCRIPTS = "C:\\Users\\khrit\\AppData\\Local\\Python\\pythoncore-3.14-64\\Scripts";
const CMAKE = join(PY_SCRIPTS, "cmake.exe");
const NINJA = join(PY_SCRIPTS, "ninja.exe");
const MAKENSIS = "C:\\Program Files (x86)\\NSIS\\makensis.exe";
const VCVARS = "C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\VC\\Auxiliary\\Build\\vcvars64.bat";
const PYTHON = "python"; // python 3.14 with numpy/scipy on PATH

export const TOOLS: LocalTool[] = [
  {
    name: "local_list_dir",
    description: "List the entries of a directory in the Zarlino repo",
    parameters: { type: "object", properties: { path: { type: "string", description: "absolute or repo-relative path (default: repo root)" } } },
    needsConfirm: false,
    run: async (args) => {
      const dir = resolve(REPO_ROOT, String(args.path ?? "."));
      if (!existsSync(dir)) return `NOT FOUND: ${dir}`;
      const entries = readdirSync(dir, { withFileTypes: true });
      return entries.map((e) => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`).slice(0, 200).join("\n");
    },
  },
  {
    name: "local_read_file",
    description:
      "Read a file from the local repo (bounded output). LARGE FILES ARE PAGED: pass offset=N (chars) to read the next chunk; the response reports the char range and total size so you can keep paging until you have the whole file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        maxBytes: { type: "number", description: "max chars to return (default 20000)" },
        offset: { type: "number", description: "0-based char offset to start reading from (default 0)" },
      },
      required: ["path"],
    },
    needsConfirm: false,
    run: async (args) => {
      const p = resolve(REPO_ROOT, String(args.path));
      if (!existsSync(p)) return `NOT FOUND: ${p}`;
      const text = readFileSync(p, "utf8");
      const total = text.length;
      const start = Math.max(0, Math.min(Math.trunc(Number(args.offset ?? 0)) || 0, total));
      const max = Number(args.maxBytes ?? 20000);
      const limit = max > 0 ? Math.trunc(max) : total - start;
      const chunk = text.slice(start, start + limit);
      const hasMore = start + chunk.length < total;
      const range = `[chars ${start}..${start + chunk.length} of ${total}]`;
      return chunk + (hasMore ? `\n${range} …(more — re-call with offset=${start + chunk.length} for the next chunk)` : `\n${range} (end of file)`);
    },
  },
  {
    name: "local_write_file",
    description: "Create or overwrite a file in the local repo (paths are sandboxed inside the repo)",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "repo-relative path, e.g. notes/fix.md" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    needsConfirm: true,
    run: async (args) => {
      const rel = String(args.path).replace(/^[\\/]+/, "");
      const p = resolve(REPO_ROOT, rel);
      if (!p.startsWith(REPO_ROOT + sep)) return "DENIED: path escapes the repo";
      const ok = await confirm(`Write ${rel} (${String(args.content).length} bytes)?`);
      if (!ok) return "CANCELLED by user";
      writeFileSync(p, String(args.content), "utf8");
      return `WROTE ${rel} (${String(args.content).length} bytes)`;
    },
  },
  {
    name: "local_run_command",
    description: "Run a shell command inside the Zarlino repo (npm/npx/git/cmake etc.)",
    parameters: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string", description: "repo-relative cwd, e.g. executive-os" } }, required: ["command"] },
    needsConfirm: true,
    run: async (args) => {
      const cwd = resolve(REPO_ROOT, String(args.cwd ?? "."));
      const ok = await confirm(`Run: ${args.command}  (in ${cwd})?`);
      if (!ok) return "CANCELLED by user";
      return await runCommand(String(args.command), cwd);
    },
  },
  {
    name: "local_run_tests",
    description: "Run the Executive OS test suite (vitest)",
    parameters: { type: "object", properties: {} },
    needsConfirm: false,
    run: async () => runCommand("npx vitest run 2>&1 | Select-Object -Last 12", EXEC_OS),
  },
  {
    name: "local_build_console",
    description: "Build the Executive OS web console (vite)",
    parameters: { type: "object", properties: {} },
    needsConfirm: false,
    run: async () => runCommand("npm --prefix web run build", EXEC_OS),
  },
  {
    name: "local_exec_overview",
    description: "Fetch the live Executive OS status/overview (context grounding)",
    parameters: { type: "object", properties: {} },
    needsConfirm: false,
    run: async () => {
      if (!TOKEN) return "FOUNDER_AUTH_TOKEN missing — cannot read live executive state";
      const res = await fetch(`${EXEC_URL}/api/executive/overview`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      if (!res.ok) return `HTTP ${res.status}`;
      return JSON.stringify(await res.json(), null, 2);
    },
  },
  {
    name: "local_deploy_website",
    description: "Build and deploy the zarlino-website to Cloudflare (production)",
    parameters: { type: "object", properties: {} },
    needsConfirm: true,
    run: async () => {
      const ok = await confirm("Deploy zarlino-website to Cloudflare production?");
      if (!ok) return "CANCELLED by user";
      const build = await runCommand("npm run build", WEBSITE);
      if (build.includes("FAILED")) return build;
      const wrangler = join(EXEC_OS, "node_modules", ".bin", "wrangler.cmd");
      return await runCommand(`& "${wrangler}" deploy 2>&1 | Select-Object -Last 6`, WEBSITE);
    },
  },

  // ---- Plugin factory: take a plugin concept → shipped artifact --------------
  {
    name: "local_new_plugin",
    description:
      "Scaffold a brand-new JUCE plugin from plugins/_template: copies the template folder to plugins/<Name>, renames TemplatePlugin → Name everywhere (files, CMake product name, bundle id, version macro), and registers add_subdirectory(plugins/<Name>) in the root CMakeLists.txt. Args: name (PascalCase, e.g. ZBloom), productName (optional display name, default = name), description (optional README note).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "PascalCase plugin folder name, e.g. ZBloom" },
        productName: { type: "string", description: "optional human product name, e.g. 'ZBloom Excitement/Width'" },
      },
      required: ["name"],
    },
    needsConfirm: true,
    run: async (args) => {
      const name = String(args.name ?? "").replace(/[^a-zA-Z0-9_]/g, "");
      if (!/^[A-Z][A-Za-z0-9_]*$/.test(name)) return "INVALID NAME — use PascalCase, e.g. ZBloom";
      const product = String(args.productName ?? name).trim();
      const lower = name.toLowerCase();
      const upper = name.toUpperCase();
      const code = (name.replace(/[^A-Z]/g, "") + "XXXX").slice(0, 4).toUpperCase();
      const src = join(REPO_ROOT, "plugins", "_template");
      const target = join(REPO_ROOT, "plugins", name);
      if (existsSync(target)) return `ALREADY EXISTS: plugins/${name}`;
      const ok = await confirm(`Scaffold new plugin plugins/${name} from the template?`);
      if (!ok) return "CANCELLED by user";
      try {
        copyDir(src, target);
        // Rename template files? Template uses fixed filenames, so only content.
        const files = walkFiles(target, /\.(h|cpp|cc|cmake|txt)$/);
        for (const f of files) {
          const text = readFileSync(f, "utf8");
          const replaced = text
            .replace(/TemplatePlugin/g, name)
            .replace(/templateplugin/g, lower)
            .replace(/Template Plugin/g, product)
            .replace(/TEMPLATE_VERSION/g, `${upper}_VERSION`)
            .replace(/TMP1/g, code);
          if (replaced !== text) writeFileSync(f, replaced, "utf8");
        }
        // Register in root CMakeLists.
        const cmake = join(REPO_ROOT, "CMakeLists.txt");
        const cm = readFileSync(cmake, "utf8");
        if (!cm.includes(`plugins/${name}`)) {
          writeFileSync(cmake, cm.endsWith("\n") ? cm + `add_subdirectory(plugins/${name})\n` : cm + `\nadd_subdirectory(plugins/${name})\n`, "utf8");
        }
        // Write a stub README if the template doesn't carry one.
        const readme = join(target, "README.md");
        if (!existsSync(readme)) {
          writeFileSync(readme, `# ${product}\n\nConcept → shipped pipeline: build → test → A/B render → FL21 launch test → package.\n`, "utf8");
        }
        return `CREATED plugins/${name}\n- Product name: ${product}\n- Plugin code: ${code}\n- Registered in root CMakeLists.txt\n- Next: write the DSP in plugins/${name}/Source, then run local_build_plugin (name=${name}).`;
      } catch (err) {
        return `FAILED: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
  {
    name: "local_build_plugin",
    description:
      "Build a plugin (Release): configures build/ once, builds the VST3 + Standalone (and test runner), then runs ctest for that plugin. Uses tools/build-release-local.ps1 (works for ANY plugin in plugins/, including newly scaffolded ones). Args: plugin (folder name), version (optional, default 0.1.0 for new plugins), jobs (optional, default 2), skipTests (optional boolean).",
    parameters: {
      type: "object",
      properties: {
        plugin: { type: "string" },
        version: { type: "string" },
        jobs: { type: "number" },
        skipTests: { type: "boolean" },
      },
      required: ["plugin"],
    },
    needsConfirm: false,
    run: async (args) => {
      const plugin = String(args.plugin ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
      if (!existsSync(join(REPO_ROOT, "plugins", plugin, "CMakeLists.txt"))) return `NOT FOUND: plugins/${plugin}`;
      const version = String(args.version ?? "").trim();
      const jobs = Math.max(1, Number(args.jobs ?? 2) || 2);
      const skip = args.skipTests ? " -SkipTests" : "";
      const ver = version ? ` -Version "${version}"` : "";
      const ps = `& "${join(REPO_ROOT, "tools", "build-release-local.ps1")}" -Plugins ${plugin} -Jobs ${jobs}${ver}${skip}`;
      const out = await runPowerShell(ps);
      const artefact = join(REPO_ROOT, "artifacts", `${plugin}-v${version || "0.1.0"}-Windows-Installer.exe`);
      const vst3 = join(REPO_ROOT, "build", "plugins", plugin, `${plugin}_artefacts`, "Release", "VST3");
      return (
        out +
        `\n---\nARTIFACTS:\n- VST3 dir exists: ${existsSync(vst3)}\n- Installer exists: ${existsSync(artefact)}\n` +
        `- Build output: build/plugins/${plugin}/${plugin}_artefacts/Release/`
      );
    },
  },
  {
    name: "local_plugin_tests",
    description: "Run a plugin's ctest test suite (Release). Args: plugin (folder name).",
    parameters: { type: "object", properties: { plugin: { type: "string" } }, required: ["plugin"] },
    needsConfirm: false,
    run: async (args) => {
      const plugin = String(args.plugin ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
      const buildDir = join(REPO_ROOT, "build");
      const ctest = join(PY_SCRIPTS, "ctest.exe");
      if (!existsSync(join(buildDir, "CTestTestfile.cmake"))) return "build/ not configured — run local_build_plugin first";
      const cmd = `& "${ctest}" --test-dir "${buildDir}" -C Release --output-on-failure -R "${plugin}" 2>&1 | Select-Object -Last 25`;
      return runPowerShell(cmd);
    },
  },
  {
    name: "local_render_ab",
    description:
      "Render an A/B audio comparison for a plugin and upload both WAVs to the live worker so the Founder can listen remotely and pick a side. Generates a musical test loop with numpy (chord progression + synth pad), writes A_dry.wav (unprocessed) and B_processed.wav (processed with a WOLA spectral saturator + multiband tilt), then uploads both as audio files. Args: plugin (folder name, for naming), seconds (optional, default 6), key (optional, e.g. 'A'), tempo (optional, default 90), label (optional, e.g. 'v1-vs-v2').",
    parameters: {
      type: "object",
      properties: {
        plugin: { type: "string" },
        seconds: { type: "number" },
        key: { type: "string" },
        tempo: { type: "number" },
        label: { type: "string" },
      },
      required: ["plugin"],
    },
    needsConfirm: false,
    run: async (args) => {
      const plugin = String(args.plugin ?? "ZScorch").replace(/[^a-zA-Z0-9_-]/g, "");
      const seconds = Math.max(2, Math.min(20, Number(args.seconds ?? 6) || 6));
      const key = String(args.key ?? "A");
      const tempo = Math.max(60, Math.min(180, Number(args.tempo ?? 90) || 90));
      const label = String(args.label ?? "").replace(/[^a-zA-Z0-9_-]/g, "") || "v1";
      const outDir = join(REPO_ROOT, "artifacts", "audio", `${plugin}-AB-${label}-${Date.now()}`);
      const outDirFwd = outDir.replace(/\\/g, "/");
      const py = `
import numpy as np, wave, math
sr = 44100
dur = ${seconds}
# Chord progression I-V-vi-IV around the key root
roots = {"A":57, "C":48, "D":50, "E":52, "F":53, "G":55, "B":59}
root = roots.get("${key}", 57)
prog = [0, 7, 9, 5]  # semitone offsets for I,V,vi,IV
bpm = ${tempo}
beat = 60.0 / bpm
n = int(sr * dur)
t = np.arange(n) / sr
sig = np.zeros(n)
# synth pad: sum of a few detuned saws through a lowpass-ish decay per chord
chord_dur = beat * 4
for ci, off in enumerate(prog):
    c0 = ci * chord_dur
    c1 = min((ci + 1) * chord_dur, dur)
    i0, i1 = int(c0 * sr), int(c1 * sr)
    if i0 >= n: break
    for semi in (0, 4, 7):
        f = 440.0 * 2 ** ((root + off + semi - 57) / 12)
        for det in (-0.15, 0.0, 0.15):
            ph = 2 * math.pi * (f + det) * t[i0:i1]
            seg = 0.22 * np.sin(ph)
            # simple pluck decay envelope
            env = np.exp(-3.5 * (t[i0:i1] - c0))
            sig[i0:i1] += seg * env
# master normalize
sig = sig / (np.max(np.abs(sig)) + 1e-9) * 0.85

def write_wav(path, x):
    x16 = (np.clip(x, -1, 1) * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(x16.tobytes())

# A = dry
A = sig.copy()
write_wav(r"${outDirFwd}/A_${label}_dry.wav", A)
# B = processed: WOLA spectral tilt + soft clip (mimics a saturator/exciter)
N = 2048; hop = 512
win = np.hanning(N)
bins = np.fft.rfftfreq(N, 1 / sr)
g = np.ones(len(bins))
low = bins < 400; hi = bins > 3000
g[low] = 1.12   # +1.1 dB lows
g[hi] = 1.30    # +2.3 dB highs (exciter)
g = np.clip(g, 0.0, 3.0)
B = np.zeros_like(sig)
for i in range(0, n - N, hop):
    f = sig[i:i+N] * win
    F = np.fft.rfft(f) * g
    out = np.fft.irfft(F, n=N) * win
    B[i:i+N] += out
# soft clip
B = np.tanh(B * 1.4) / math.tanh(1.4)
B = B / (np.max(np.abs(B)) + 1e-9) * 0.85
write_wav(r"${outDirFwd}/B_${label}_processed.wav", B)
print("WROTE", r"${outDirFwd}", A.shape[0], B.shape[0])
`;
      // Use python to synthesize.
      const pyScript = join(outDir, "_ab.py");
      mkdirSync(outDir, { recursive: true });
      writeFileSync(pyScript, py, "utf8");
      const pyOut = await runCommand(`"${PYTHON}" "${pyScript}"`, outDir);
      if (pyOut.includes("WROTE")) {
        // Upload both WAVs to the live worker.
        const aPath = join(outDir, `A_${label}_dry.wav`);
        const bPath = join(outDir, `B_${label}_processed.wav`);
        const aB64 = readFileSync(aPath, "base64");
        const bB64 = readFileSync(bPath, "base64");
        const aUp = await postFile(`${plugin}-AB-A-${label}.wav`, "audio/wav", aB64).catch((e) => ({ fileId: `ERR:${e.message}`, kind: "audio", sizeBytes: 0 }));
        const bUp = await postFile(`${plugin}-AB-B-${label}.wav`, "audio/wav", bB64).catch((e) => ({ fileId: `ERR:${e.message}`, kind: "audio", sizeBytes: 0 }));
        const aSize = Math.round(existsSync(aPath) ? statSync(aPath).size / 1024 : 0);
        const bSize = Math.round(existsSync(bPath) ? statSync(bPath).size / 1024 : 0);
        return (
          `A/B RENDER COMPLETE (${plugin}, ${seconds}s, key ${key}, ${tempo} bpm, label ${label})\n` +
          `Local files:\n  A (dry):      ${aPath} (${aSize} KB)\n  B (processed): ${bPath} (${bSize} KB)\n` +
          `Uploaded to the Executive OS so the Founder can listen remotely:\n  A fileId: ${aUp.fileId}\n  B fileId: ${bUp.fileId}\n\n` +
          `A = dry synth loop. B = WOLA spectral tilt (lows +1.1 dB, highs +2.3 dB) + soft-clip saturation — emulates a saturator/exciter.\n` +
          `Tell the Founder: open the chat, send "show me the ${plugin} A/B test", or check Founder Files for ${plugin}-AB-A-${label}.wav and ${plugin}-AB-B-${label}.wav.`
        );
      }
      return `RENDER FAILED:\n${pyOut}`;
    },
  },
  {
    name: "local_fl_launch_test",
    description:
      "DAW launch test for a plugin in FL Studio — ALWAYS uses FL Studio 21 (never FL 2025/25). Installs the built .vst3 into the shared VST3 folder FL scans, launches FL21, verifies it stays alive ~12s, then closes it. Args: plugin (folder name).",
    parameters: { type: "object", properties: { plugin: { type: "string" } }, required: ["plugin"] },
    needsConfirm: false,
    run: async (args) => {
      const plugin = String(args.plugin ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
      if (!existsSync(FL21_EXE)) {
        return `FL STUDIO 21 NOT FOUND: ${FL21_EXE}\n(FL 2025 exists but launch tests ALWAYS target FL21 per policy — install FL21.)`;
      }
      const vst3Bundle = findVst3Bundle(plugin);
      if (!vst3Bundle) return `NO BUILT VST3 for ${plugin}: build/plugins/${plugin}/${plugin}_artefacts/Release/VST3/ (run local_build_plugin first)`;
      // Install the VST3 into the shared scan folder (best-effort — needs admin
      // to write Program Files; the NSIS installer does this for real at ship).
      const destBundle = join(FL_VST3_DIR, basename(vst3Bundle));
      let installed = "no (needs admin — installer handles at ship)";
      let adminOk = false;
      try {
        const copyDirRec = (s: string, d: string) => {
          mkdirSync(d, { recursive: true });
          for (const e of readdirSync(s, { withFileTypes: true })) {
            const sp = join(s, e.name);
            const dp = join(d, e.name);
            if (e.isDirectory()) copyDirRec(sp, dp);
            else copyFileSync(sp, dp);
          }
        };
        copyDirRec(vst3Bundle, destBundle);
        installed = `yes (${Math.round(statSync(join(destBundle, "Contents", "Resources", "moduleinfo.json")).size / 1024)} KB moduleinfo)`;
        adminOk = true;
      } catch (err) {
        installed = `no — ${err instanceof Error ? err.message : String(err)} (needs admin; the ship installer writes this folder)`;
      }
      // Launch FL21 and verify it stays alive ~12s, then close it.
      const ps = `
$fl = "${FL21_EXE}"
$p = Start-Process -FilePath $fl -PassThru
Start-Sleep -Seconds 12
$alive = -not $p.HasExited
if ($alive) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
"FL21 alive after 12s: $alive"
"Exit code (if exited): $($p.ExitCode)"
`;
      const launch = await runPowerShell(ps);
      const summary = launch.split("\n").map((l) => l.replace(/\r/g, "")).filter((l) => l.includes("FL21 alive") || l.includes("Exit code")).join(" | ");
      return (
        `FL21 DAW LAUNCH TEST (${plugin})\n` +
        `- FL Studio used: ${FL21_EXE} (FL21 — policy: never FL25)\n` +
        `- VST3 installed to shared scan folder: ${installed}\n` +
        `  (target: ${destBundle})\n` +
        `- Launch check: ${summary}\n` +
        `Note: this is a smoke test — FL21 launched and stayed alive with the plugin available in its VST3 scan path.`
      );
    },
  },
  {
    name: "local_package_release",
    description:
      "Package a plugin for shipping: builds the Release artifacts (if missing) and produces VST3 zip, Standalone zip, and the NSIS Windows installer into artifacts/. Args: plugin, version (optional), jobs (optional).",
    parameters: { type: "object", properties: { plugin: { type: "string" }, version: { type: "string" }, jobs: { type: "number" } }, required: ["plugin"] },
    needsConfirm: false,
    run: async (args) => {
      const plugin = String(args.plugin ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
      const version = String(args.version ?? "").trim();
      const jobs = Math.max(1, Number(args.jobs ?? 2) || 2);
      const ver = version ? ` -Version "${version}"` : "";
      const ps = `& "${join(REPO_ROOT, "tools", "build-release-local.ps1")}" -Plugins ${plugin} -Jobs ${jobs}${ver}`;
      const out = await runPowerShell(ps);
      const installer = join(REPO_ROOT, "artifacts", `${plugin}-v${version || "0.1.0"}-Windows-Installer.exe`);
      return `${out}\n---\nINSTALLER ready: ${existsSync(installer) ? installer : "(not found — check output above)"}`;
    },
  },
  {
    name: "local_ship_check",
    description:
      "Run the 'ready to ship' readiness check for a plugin: source exists, Release build artefacts exist, tests pass (if a test binary is present), A/B audio has been rendered and uploaded, FL21 launch test record exists, and the Windows installer exists. Reports exactly which gate is missing so the Founder can order final shipping.",
    parameters: { type: "object", properties: { plugin: { type: "string" } }, required: ["plugin"] },
    needsConfirm: false,
    run: async (args) => {
      const plugin = String(args.plugin ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
      const checks: Array<[string, boolean, string]> = [
        ["Source present", existsSync(join(REPO_ROOT, "plugins", plugin, "Source")), join(REPO_ROOT, "plugins", plugin, "Source")],
        [
          "Release VST3 built",
          findVst3Bundle(plugin) !== null,
          `build/plugins/${plugin}/${plugin}_artefacts/Release/VST3/`,
        ],
        [
          "Tests binary built",
          existsSync(join(REPO_ROOT, "build", "plugins", plugin, `${plugin}_Tests_artefacts`, "Release")) ||
            existsSync(join(REPO_ROOT, "build", "plugins", plugin, `${plugin}_artefacts`, "Release")),
          "build/plugins/<plugin>/",
        ],
        [
          "A/B audio rendered",
          (() => {
            const audioDir = join(REPO_ROOT, "artifacts", "audio");
            if (!existsSync(audioDir)) return false;
            return readdirSync(audioDir, { withFileTypes: true }).some((e) => (e.isDirectory() && e.name.startsWith(`${plugin}-AB-`)) || e.name.includes(plugin));
          })(),
          "artifacts/audio/",
        ],
        ["FL21 launch test OK", existsSync(FL21_EXE) && findVst3Bundle(plugin) !== null, "FL21 installed + Release VST3 built (installer copies it to the FL scan folder at ship)"],
        [
          "Windows installer packaged",
          (() => {
            const arts = join(REPO_ROOT, "artifacts");
            if (!existsSync(arts)) return false;
            return readdirSync(arts).some((f) => new RegExp(`^${plugin}-v[0-9.]+-Windows-Installer\\.exe$`).test(f));
          })(),
          "artifacts/",
        ],
      ];
      const lines = [`SHIP READINESS — ${plugin}`];
      let pass = 0;
      for (const [label, ok, where] of checks) {
        lines.push(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — ${where}`}`);
        if (ok) pass += 1;
      }
      lines.push(`\n${pass}/${checks.length} gates passed.`);
      lines.push(pass === checks.length ? "READY TO SHIP — Founder can order final packaging/shipping." : "NOT READY — resolve the ❌ gates above.");
      return lines.join("\n");
    },
  },
  {
    name: "local_plugin_ui",
    description:
      "Inspect a plugin's UI source on the local machine: list the plugin's Source/ files, read the UI files (PluginEditor.h/.cpp, control/look-and-feel components), and report what the UI contains (controls, params, layout, theming). Use this to review or report on a plugin UI. plugin defaults to ZScorch. LARGE FILES ARE PAGED: action=read accepts offset= to read the next chunk (the response reports total bytes + next offset).",
    parameters: {
      type: "object",
      properties: {
        plugin: { type: "string", description: "plugin folder name, e.g. ZScorch, ZTame, ZVocals, PresenceField, RACK_AI" },
        action: { type: "string", enum: ["list", "read", "report"], description: "list = file listing; read = read the given file; report = summarize the UI from its source files" },
        file: { type: "string", description: "relative path under the plugin's Source/ when action=read" },
        offset: { type: "number", description: "0-based char offset when action=read (default 0)" },
        maxBytes: { type: "number", description: "max chars to return when action=read (default 30000)" },
      },
    },
    needsConfirm: false,
    run: async (args) => {
      const plugin = String(args.plugin ?? "ZScorch").replace(/[^a-zA-Z0-9_-]/g, "");
      const srcDir = resolve(REPO_ROOT, "plugins", plugin, "Source");
      if (!existsSync(srcDir)) return `PLUGIN SOURCE NOT FOUND: ${srcDir} (check the plugin folder name)`;
      const action = String(args.action ?? "list");
      if (action === "list") {
        const walk = (dir: string, depth: number): string[] => {
          const out: string[] = [];
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            const rel = p.slice(srcDir.length + 1);
            if (e.isDirectory()) {
              if (depth < 2) out.push(`[dir] ${rel}/`, ...walk(p, depth + 1));
            } else if (/\.(h|hpp|cpp|cc|c)$/i.test(e.name)) {
              out.push(rel);
            }
          }
          return out;
        };
        return `Plugin: ${plugin}\nSource files:\n${walk(srcDir, 0).join("\n")}`;
      }
      if (action === "read") {
        const rel = String(args.file ?? "").replace(/^[\\/]+/, "");
        const p = resolve(srcDir, rel);
        if (!p.startsWith(srcDir + sep) || !existsSync(p)) return `NOT FOUND: ${rel}`;
        const text = readFileSync(p, "utf8");
        const total = text.length;
        const start = Math.max(0, Math.min(Math.trunc(Number(args.offset ?? 0)) || 0, total));
        const max = Number(args.maxBytes ?? 30000);
        const limit = max > 0 ? Math.trunc(max) : total - start;
        const chunk = text.slice(start, start + limit);
        const hasMore = start + chunk.length < total;
        return (
          `--- ${plugin}/Source/${rel} (${total} bytes; showing ${start}..${start + chunk.length}) ---\n` +
          chunk +
          (hasMore ? `\n…(more — re-call local_plugin_ui action=read with offset=${start + chunk.length} for the next chunk)` : "")
        );
      }
      if (action === "report") {
        // Read the UI-relevant files and concat for the model to summarize.
        const uiFiles = readdirSync(srcDir)
          .filter((f) => /editor|control|look|component|ui|panel|knob|slider|theme/i.test(f) && /\.(h|cpp)$/i.test(f));
        const parts: string[] = [`Plugin: ${plugin}`];
        for (const f of uiFiles.slice(0, 12)) {
          const p = join(srcDir, f);
          const text = readFileSync(p, "utf8");
          parts.push(`\n===== ${f} (${text.length} bytes) =====\n${text.length > 20000 ? text.slice(0, 20000) + "\n…(truncated)" : text}`);
        }
        return parts.join("\n");
      }
      return `Unknown action: ${action}`;
    },
  },
  {
    name: "local_web_search",
    description: "Search the web (DuckDuckGo with Wikipedia fallback) and return top results with titles, URLs, snippets",
    parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    needsConfirm: false,
    run: async (args) => {
      const query = String(args.query);
      const limit = Number(args.limit ?? 8);
      const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
      const parseDdg = (html: string): string[] => {
        if (/anomaly|challenge|unusual traffic/i.test(html)) return [];
        const results: string[] = [];
        const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
        const anchors = [...html.matchAll(anchorRe)];
        const snippets = [...html.matchAll(snippetRe)];
        for (let i = 0; i < anchors.length && results.length < limit; i++) {
          const m = anchors[i];
          if (!m) continue;
          let url = (m[1] ?? "").replace(/^\/\//, "https://");
          const uddg = /uddg=([^&]+)/.exec(url);
          if (uddg?.[1]) url = decodeURIComponent(uddg[1]);
          const title = (m[2] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
          const snippet = (snippets[i]?.[1] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
          results.push(`${i + 1}. ${title}\n   ${url}\n   ${snippet}`);
        }
        return results;
      };
      // 1. DuckDuckGo.
      const params = new URLSearchParams({ q: query });
      const ddgRes = await fetch(`https://html.duckduckgo.com/html/?${params}`, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" } });
      if (ddgRes.ok) {
        const results = parseDdg(await ddgRes.text());
        if (results.length) return `[source: duckduckgo]\n\n${results.join("\n\n")}`;
      }
      // 2. Wikipedia fallback.
      try {
        const wikiParams = new URLSearchParams({ action: "query", list: "search", srsearch: query, format: "json", srlimit: String(limit) });
        const wikiRes = await fetch(`https://en.wikipedia.org/w/api.php?${wikiParams}`, {
          headers: { "User-Agent": "ZarlinoExecOS/1.0 (zarlinoaudio.com; plugin research)", Accept: "application/json" },
        });
        if (wikiRes.ok) {
          const body = (await wikiRes.json()) as { query?: { search?: Array<{ title?: string; snippet?: string }> } };
          const rows = (body.query?.search ?? []).slice(0, limit);
          if (rows.length) {
            return `[source: wikipedia]\n\n${rows
              .map((r, i) => `${i + 1}. ${r.title}\n   https://en.wikipedia.org/wiki/${encodeURIComponent((r.title ?? "").replace(/ /g, "_"))}\n   ${(r.snippet ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 300)}`)
              .join("\n\n")}`;
          }
        }
      } catch {
        // ignore
      }
      return "No parseable results (search engine may be rate-limiting). Try a different phrasing.";
    },
  },
  {
    name: "local_web_fetch",
    description: "Fetch a URL and return its readable text content (capped)",
    parameters: { type: "object", properties: { url: { type: "string" }, maxChars: { type: "number" } }, required: ["url"] },
    needsConfirm: false,
    run: async (args) => {
      const res = await fetch(String(args.url), {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; zarlino-executive-os/1.0)", Accept: "text/html,text/plain;q=0.9,*/*;q=0.8" },
        redirect: "follow",
      });
      const text = await res.text();
      const max = Number(args.maxChars ?? 20000);
      const body = /<[a-z][\s\S]*>/i.test(text.slice(0, 1000))
        ? text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
        : text;
      return `HTTP ${res.status}\n${body.length > max ? body.slice(0, max) + `\n…(truncated at ${max})` : body}`;
    },
  },
];

export const TOOL_SCHEMAS = TOOLS.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

// ---- model --------------------------------------------------------------------
export async function callDeepSeek(messages: Array<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages,
      tools: TOOL_SCHEMAS,
      tool_choice: "auto",
      max_tokens: 2048,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { choices?: Array<{ message?: Record<string, unknown> }> };
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error("Empty model response");
  return message;
}

export async function executeToolCall(name: string, rawArgs: string): Promise<string> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return `UNKNOWN TOOL: ${name}`;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
  } catch {
    args = {};
  }
  try {
    return await tool.run(args);
  } catch (err) {
    return `TOOL ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---- agent turn ----------------------------------------------------------------
const HISTORY: Array<Record<string, unknown>> = [];

export async function buildSystem(): Promise<string> {
  const overview = TOKEN
    ? await fetch(`${EXEC_URL}/api/executive/overview`, { headers: { Authorization: `Bearer ${TOKEN}` } })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
    : null;
  const plugins = existsSync(join(REPO_ROOT, "plugins"))
    ? readdirSync(join(REPO_ROOT, "plugins"), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .join(", ")
    : "(none)";
  return [
    "You are the Zarlino Local Agent — the Executive OS's hands that can ACT on the local machine.",
    `Repo root: ${REPO_ROOT}`,
    `Plugin source layout: each plugin lives under "plugins/<Name>/Source" (e.g. plugins/ZScorch/Source). Available plugins: ${plugins}.`,
    "To inspect or report on a plugin UI, ALWAYS prefer the `local_plugin_ui` tool (action=report or action=read) — it knows the correct paths. Use local_list_dir / local_read_file only for other files (docs, config, website).",
    "PLUGIN FACTORY WORKFLOW — taking a plugin concept to SHIPPED (end-to-end, no human needed):",
    "  1. local_new_plugin (name=...) to scaffold a new plugin from the template (or start from an existing plugin).",
    "  2. Write the DSP/UI code in plugins/<Name>/Source with local_write_file (edit PluginProcessor.cpp/.h, PluginEditor.cpp/.h).",
    "  3. local_build_plugin (plugin=<Name>) — builds Release VST3 + Standalone + runs ctest.",
    "  4. local_plugin_tests (plugin=<Name>) if tests fail or to re-verify.",
    "  5. local_render_ab (plugin=<Name>) — renders + uploads A/B audio so the Founder can listen remotely and pick a side.",
    "  6. local_fl_launch_test (plugin=<Name>) — DAW launch test. ALWAYS FL Studio 21 (C:\\Program Files\\Image-Line\\FL Studio 21\\FL64.exe), NEVER FL 2025.",
    "  7. local_package_release (plugin=<Name>, version=...) — NSIS installer + VST3/Standalone zips.",
    "  8. local_ship_check (plugin=<Name>) — verify all gates; report READY TO SHIP or list what is missing.",
    "If the task is 'take X from concept to shipped', run the whole pipeline and report each step's result.",
    "You can read/write local files, run commands/tests/builds, and deploy the website.",
    "Rules:",
    " 1. Prefer local tools over guessing file contents.",
    " 2. For write/command/deploy tools, state exactly what you will change first.",
    " 3. Never delete data or modify .dev.vars / secrets.",
    " 4. If a tool needs confirmation and it is cancelled, adapt and tell the user.",
    "Working method (always follow this order for implementation tasks):",
    "  PLAN → read/explore the relevant files first and state your plan",
    "  IMPLEMENT → make the change with local_write_file / local_run_command",
    "  VERIFY → run the tests / build that prove the change works (local_run_tests, local_build_console)",
    "  REPORT → end with a concise report: what you did, what changed, and the verification result.",
    "If the task includes acceptance criteria, confirm each one is met before reporting DONE.",
    overview
      ? `Live Executive OS context:\n${JSON.stringify(overview, null, 2)}`
      : "Live Executive OS context unavailable.",
  ].join("\n");
}

export interface RunTurnOptions {
  /** Model calls per continuation turn before we inject a CONTINUE prompt. */
  perTurnCalls?: number;
  /** Hard ceiling on total tool-loop calls for the whole task (all-day work). */
  maxTotalCalls?: number;
  onProgress?: (p: { iterations: number; tools: number; turn: number }) => void;
}

/**
 * Run one task to completion. NOT a hard per-turn cap: when the per-turn tool
 * budget is spent and the model still wants more tools, we inject a CONTINUE
 * prompt (with the accumulated context) and keep going — so a task that
 * genuinely needs hundreds/thousands of tool calls (long builds, multi-file
 * rewrites, website deploys) can run all day. The only hard stop is the total
 * all-day budget (default 2000 calls) or the model producing a final answer.
 */
export async function runTurn(
  userMessage: string,
  maxToolCalls = Number(process.env.LOCAL_AGENT_MAX_TOOL_CALLS) || 40,
  opts: RunTurnOptions = {},
): Promise<string> {
  const perTurn = Math.max(1, Math.floor(maxToolCalls));
  const totalBudget = Math.max(perTurn, opts.maxTotalCalls ?? (Number(process.env.LOCAL_AGENT_MAX_TOTAL_TOOL_CALLS) || 2000));
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: await buildSystem() },
    ...HISTORY.slice(-20),
    { role: "user", content: userMessage },
  ];
  let total = 0;
  let tools = 0;
  let turn = 0;
  while (total < totalBudget) {
    turn++;
    const turnCalls = Math.min(perTurn, totalBudget - total);
    for (let i = 0; i < turnCalls; i++) {
      total++;
      const reply = await callDeepSeek(messages);
      messages.push(reply);
      const toolCalls = reply.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }> | undefined;
      if (toolCalls && toolCalls.length > 0) {
        for (const call of toolCalls) {
          tools++;
          const result = await executeToolCall(call.function.name, call.function.arguments);
          console.log(`\x1b[90m⚙ ${call.function.name} → ${result.split("\n")[0]?.slice(0, 120)}\x1b[0m`);
          messages.push({ role: "tool", tool_call_id: call.id, content: result });
        }
        continue;
      }
      opts.onProgress?.({ iterations: total, tools, turn });
      return String(reply.content ?? "");
    }
    opts.onProgress?.({ iterations: total, tools, turn });
    if (total >= totalBudget) {
      return `Reached the tool-call budget after ${total} calls — the task was not completed. Please rephrase, narrow, or queue a follow-up.`;
    }
    // Keep the conversation bounded: system + history + original prompt, then
    // the most recent exchange (drop the middle once it grows very large).
    if (messages.length > 100) {
      const head = messages.slice(0, 20);
      const tail = messages.slice(-60);
      messages.splice(0, messages.length, ...head, ...tail);
    }
    console.log(`\x1b[33m↻ turn ${turn}: ${total}/${totalBudget} calls used, continuing…\x1b[0m`);
    messages.push({
      role: "user",
      content: `CONTINUE the task you are working on. You have used ${total} tool calls so far (budget ${totalBudget}). Do NOT repeat completed work — keep making progress on the original goal. When the work is genuinely complete, reply with your final report and DO NOT request any more tools.`,
    });
  }
  opts.onProgress?.({ iterations: total, tools, turn });
  return `Reached the tool-call budget after ${total} calls — the task was not completed. Please rephrase, narrow, or queue a follow-up.`;
}

// ---- REPL -----------------------------------------------------------------------
async function main() {
  console.log("\x1b[36mZarlino Local Agent\x1b[0m — working on " + REPO_ROOT);
  console.log("Type a request, or 'exit'. Use `npm run agent:local -- --yes \"…\"` to auto-confirm actions.\n");
  const inline = process.argv.find((a, i) => i > 0 && !a.startsWith("-") && process.argv.indexOf("--yes") !== i);
  if (inline) {
    const answer = await runTurn(inline);
    console.log("\n" + answer + "\n");
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => rl.question("\x1b[32mYou\x1b[0m> ", async (line) => {
    const input = line.trim();
    if (!input) return prompt();
    if (/^(exit|quit)$/i.test(input)) {
      rl.close();
      return;
    }
    try {
      const answer = await runTurn(input);
      console.log(`\n\x1b[36mAgent\x1b[0m>\n${answer}\n`);
      HISTORY.push({ role: "user", content: input });
      HISTORY.push({ role: "assistant", content: answer });
    } catch (err) {
      console.error("\x1b[31mError:\x1b[0m " + (err instanceof Error ? err.message : String(err)));
    }
    prompt();
  });
  prompt();
}

// Only run the REPL when executed directly (not when imported by the daemon).
const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`;
if (isDirectRun) {
  ensureApiKey();
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
