/**
 * upload-audio — push pre-rendered local audio files into the Executive OS file store.
 *
 * PURPOSE
 *   The web console has no way to ingest a file rendered locally (eg the ZScorch A/B WAVs
 *   at artifacts/ab-sources/zscorch/ab-review/). This tool POSTs each local WAV to the
 *   live worker's POST /api/files endpoint (the same upload mechanism local_render_ab /
 *   postFile already use), authenticated with FOUNDER_AUTH_TOKEN from .dev.vars. Files
 *   land in the SAME uploaded_files store that executive_list_files / executive_get_file
 *   read, so returned fileIds are valid for review_request_sound_approval.
 *
 * USAGE (from executive-os/):
 *   npm run upload:audio -- <filepath> [<filepath> ...]
 *   EXEC_OS_URL=https://<worker> npm run upload:audio -- <filepath>   # override worker
 *
 * OUTPUT: per file — the upf_ fileId, kind (audio), mime (audio/wav), size, and a
 *   GET /api/files/{id} round-trip verification. Exit 0 iff every file uploaded AND
 *   stayed fetchable.
 *
 * VALIDATION: file exists & is regular; RIFF/WAVE magic at offset 0/8; base64 body
 *   under the worker's ~11MB cap (15,000,000 chars).
 */
import { existsSync, openSync, readSync, closeSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "./dotenv.js";

const SCRIPT_DIR = resolve(fileURLToPath(import.meta.url), "..");
const EXEC_OS = resolve(SCRIPT_DIR, "..");

const dotenv = loadDotEnv(join(EXEC_OS, ".dev.vars"));
const TOKEN = process.env.FOUNDER_AUTH_TOKEN ?? dotenv.FOUNDER_AUTH_TOKEN ?? "";
const EXEC_URL = process.env.EXEC_OS_URL ?? "https://zarlino-executive-os.zarlino001.workers.dev";

const MAX_BASE64_CHARS = 15_000_000;
const WAV_KIND = "audio";
const WAV_MIME = "audio/wav";

interface UploadResult { name: string; fileId: string; kind: string; sizeBytes: number }
interface FileRecord { id: string; name: string; mime?: string; kind?: string; data_base64?: string; size_bytes?: number }

function validateWavHeader(p: string): { ok: boolean; detail: string; sizeBytes: number } {
  const sizeBytes = statSync(p).size;
  if (sizeBytes < 44) return { ok: false, detail: `too small to be a valid WAV (${sizeBytes} bytes)`, sizeBytes };
  const buf = Buffer.alloc(12);
  const fd = openSync(p, "r");
  try { readSync(fd, buf, 0, 12, 0); } finally { closeSync(fd); }
  const riff = buf.toString("ascii", 0, 4);
  const wave = buf.toString("ascii", 8, 12);
  if (riff !== "RIFF" || wave !== "WAVE") {
    return { ok: false, detail: `bad WAV header (RIFF=${riff}, WAVE=${wave}) — expected RIFF@0 / WAVE@8`, sizeBytes };
  }
  return { ok: true, detail: `RIFF/WAVE header OK (${sizeBytes} bytes)`, sizeBytes };
}

async function postFile(name: string, mime: string, dataBase64: string): Promise<UploadResult> {
  const res = await fetch(`${EXEC_URL}/api/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, mime, dataBase64 }),
  });
  if (!res.ok) throw new Error(`upload HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { ok?: boolean; fileId?: string; kind?: string; sizeBytes?: number; error?: string };
  if (!body.fileId) throw new Error(`upload returned no fileId${body.error ? ` (${body.error})` : ""}`);
  return { name, fileId: body.fileId, kind: body.kind ?? "", sizeBytes: body.sizeBytes ?? 0 };
}

/** Round-trip read through executive_get_file so we know the file is fetchable. */
async function getFile(id: string): Promise<FileRecord> {
  const res = await fetch(`${EXEC_URL}/api/files/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`GET /api/files/${id} -> HTTP ${res.status}`);
  return (await res.json()) as FileRecord;
}


async function uploadOne(rawPathArg: string): Promise<UploadResult> {
  const p = resolve(rawPathArg);
  if (!existsSync(p)) throw new Error(`not found: ${p}`);
  if (!statSync(p).isFile()) throw new Error(`not a regular file: ${p}`);
  const wav = validateWavHeader(p);
  if (!wav.ok) throw new Error(wav.detail);
  const dataBase64 = readFileSync(p, "base64");
  if (dataBase64.length > MAX_BASE64_CHARS) {
    throw new Error(`encoded size ${dataBase64.length} chars exceeds worker cap ${MAX_BASE64_CHARS} (~11 MB): ${p}`);
  }
  const name = rawPathArg.split(/[/\\]/).pop() || `audio-${Date.now()}.wav`;
  const up = await postFile(name, WAV_MIME, dataBase64);
  const got = await getFile(up.fileId);
  if (!got || got.id !== up.fileId) throw new Error(`uploaded file ${up.fileId} not recoverable via executive_get_file`);
  const readable = typeof got.data_base64 === "string" && got.data_base64.length > 0;
  if (!readable) throw new Error(`uploaded file ${up.fileId} has no readable payload`);
  console.log(`[OK] ${name}`);
  console.log(`   fileId       : ${up.fileId}`);
  console.log(`   kind         : ${got.kind ?? WAV_KIND}`);
  console.log(`   mime         : ${got.mime ?? WAV_MIME}`);
  console.log(`   size         : ${up.sizeBytes} bytes (${(wav.sizeBytes / 1024).toFixed(1)} KB on disk)`);
  console.log(`   verification : GET /api/files/${up.fileId} -> ${readable ? "READABLE OK" : "empty"}`);
  return up;
}

async function main(): Promise<void> {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("Usage: npm run upload:audio -- <filepath> [<filepath> ...]");
    console.error("Upload one or more local audio files into the Executive OS file store and print fileIds (upf_...).");
    console.error("See the JSDoc header of scripts/upload-audio.ts for full docs.");
    process.exit(2);
  }
  if (!TOKEN) {
    console.error("FOUNDER_AUTH_TOKEN not found — add it to executive-os/.dev.vars or the environment.");
    process.exit(1);
  }
  let allOk = true;
  for (const p of paths) {
    try {
      await uploadOne(p.trim());
    } catch (e) {
      allOk = false;
      console.error(`[FAIL] ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(allOk ? "ALL UPLOADS OK" : "ONE OR MORE UPLOADS FAILED");
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
