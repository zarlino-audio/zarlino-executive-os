/**
 * Zarlino WhatsApp Bridge — linked-device mode.
 *
 * Links a REAL WhatsApp account (business or personal) to the Executive OS
 * exactly like WhatsApp Web does: scan a QR once, the session persists in
 * ./auth, and from then on:
 *
 *   INBOUND   every direct message is forwarded to POST /api/whatsapp/inbound.
 *             The OS classifies the sender (FOUNDER vs STRANGER) and returns
 *             the reply text, which this bridge sends back. Duplicate
 *             redeliveries are ignored (the OS dedupes on message id).
 *   OUTBOUND  every 15 s the bridge drains GET /api/whatsapp/outbox (CEO
 *             escalations recorded as QUEUED*) and sends them to the founder,
 *             then acks delivery so the OS status is honest (SENT/FAILED).
 *
 * Config (env or defaults):
 *   EXEC_URL    default https://os.zarlinoaudio.com
 *   EXEC_TOKEN  bearer token; falls back to FOUNDER_AUTH_TOKEN in ../../.dev.vars
 *   QR_PORT     default 3037 (page auto-refreshes the QR while linking)
 */
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import P from "pino";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const EXEC_URL = (process.env.EXEC_URL || "https://os.zarlinoaudio.com").replace(/\/$/, "");
const QR_PORT = Number(process.env.QR_PORT || 3037);
const POLL_MS = Number(process.env.OUTBOX_POLL_MS || 15000);
const logger = P({ level: "silent" });

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function loadToken() {
  if (process.env.EXEC_TOKEN) return process.env.EXEC_TOKEN.trim();
  try {
    const raw = fs.readFileSync(path.join(DIR, "..", "..", ".dev.vars"), "utf8");
    const line = raw.split(/\r?\n/).find((l) => l.startsWith("FOUNDER_AUTH_TOKEN="));
    if (line) return line.slice("FOUNDER_AUTH_TOKEN=".length).trim();
  } catch {}
  return "";
}

const TOKEN = loadToken();
if (!TOKEN) {
  console.error("No token — set EXEC_TOKEN or ensure ../../.dev.vars has FOUNDER_AUTH_TOKEN.");
  process.exit(1);
}

const headers = () => ({ Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" });

// ---- QR web page -----------------------------------------------------------
let qrDataUrl = null;
let status = "starting";
let linkedAs = null;

function renderPage() {
  const body = qrDataUrl
    ? `<img src="${qrDataUrl}" alt="WhatsApp linking QR" />`
    : `<div class="hint">${status === "linked" ? "Linked — no QR needed." : "Waiting for a fresh QR from WhatsApp…"}</div>`;
  return `<!doctype html>
<html><head><meta charset="utf-8" /><meta http-equiv="refresh" content="4" />
<title>Zarlino WhatsApp Bridge</title>
<style>
  body{background:#0b0d12;color:#e8e6e3;font-family:system-ui,Segoe UI,sans-serif;display:flex;flex-direction:column;align-items:center;gap:14px;padding:34px}
  h1{font-size:20px;margin:0;font-weight:600}
  .st{opacity:.85;font-size:14px} .st b{color:${status === "linked" ? "#34d399" : "#fbbf24"}}
  img{width:330px;height:330px;background:#fff;padding:14px;border-radius:14px}
  .hint{opacity:.7;max-width:560px;text-align:center;font-size:14px;line-height:1.5}
  .steps{max-width:560px;text-align:left;font-size:14px;line-height:1.6;opacity:.85}
  code{background:#1c2130;padding:2px 6px;border-radius:6px}
</style></head>
<body>
  <h1>Zarlino OS — link the business WhatsApp</h1>
  <div class="st">Status: <b>${status}</b>${linkedAs ? ` (${linkedAs})` : ""}</div>
  ${body}
  <div class="steps">
    On the phone that holds the business WhatsApp account:<br />
    1. WhatsApp → Settings → <b>Linked devices</b><br />
    2. <b>Link a device</b><br />
    3. Scan the code above (it refreshes automatically)</div>
  <div class="hint">Messages from +233 54 677 8438 are handled as the FOUNDER channel.
  All other numbers get a public stranger reply only — no internal information.</div>
</body></html>`;
}

http
  .createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(renderPage());
  })
  .listen(QR_PORT, () => log(`QR page: http://localhost:${QR_PORT}/`));

// ---- WhatsApp connection ---------------------------------------------------
let sock = null;
let drainTimer = null;

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(DIR, "auth"));
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = undefined;
  }
  sock = makeWASocket({
    auth: state,
    version,
    logger,
    browser: ["Zarlino OS Bridge", "Chrome", "1.0.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    if (u.qr) {
      qrDataUrl = await QRCode.toDataURL(u.qr, { width: 340, margin: 1 });
      status = "waiting for scan";
      try {
        await QRCode.toFile(path.join(DIR, "qr.png"), u.qr, { width: 420 });
      } catch {}
      log(`QR ready — open http://localhost:${QR_PORT}/ and scan with the business WhatsApp`);
    }
    if (u.connection === "open") {
      qrDataUrl = null;
      status = "linked";
      linkedAs = sock.user?.id ?? "unknown";
      log(`LINKED as ${linkedAs}`);
      if (drainTimer) clearInterval(drainTimer);
      drainTimer = setInterval(() => void drainOutbox(), POLL_MS);
      void drainOutbox();
    }
    if (u.connection === "close") {
      const code = u.lastDisconnect?.error?.output?.statusCode ?? u.lastDisconnect?.error?.message;
      if (drainTimer) {
        clearInterval(drainTimer);
        drainTimer = null;
      }
      if (code === DisconnectReason.loggedOut || code === 401) {
        status = "logged out — delete auth/ and restart to re-link";
        log(`Logged out (${code}). Delete ${path.join(DIR, "auth")} and restart to link again.`);
        process.exit(2);
      }
      status = "reconnecting";
      log(`Connection closed (${code}) — reconnecting in 5 s`);
      setTimeout(() => void connect(), 5000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      try {
        if (!m.message || m.key.fromMe) continue;
        const jid = m.key.remoteJid || "";
        if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") continue; // groups/status ignored
        const text =
          m.message.conversation ||
          m.message.extendedTextMessage?.text ||
          m.message.imageMessage?.caption ||
          m.message.videoMessage?.caption ||
          "";
        if (!text.trim()) continue;
        const from = jid.split("@")[0].split(":")[0];
        const res = await fetch(`${EXEC_URL}/api/whatsapp/inbound`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ from, name: m.pushName ?? undefined, text, messageId: m.key.id ?? undefined }),
        });
        if (!res.ok) {
          log(`inbound HTTP ${res.status} for ${from}`);
          continue;
        }
        const data = await res.json();
        if (data.reply && !data.duplicate) {
          await sock.sendMessage(jid, { text: data.reply });
          log(`[${data.role}] replied to ${from}`);
        } else {
          log(`[${data.role}] ${from}: no reply (duplicate=${data.duplicate})`);
        }
      } catch (err) {
        log(`message error: ${err?.message ?? err}`);
      }
    }
  });
}

// ---- Outbox drain (founder escalations) ------------------------------------
async function drainOutbox() {
  if (!sock || status !== "linked") return;
  let data;
  try {
    const res = await fetch(`${EXEC_URL}/api/whatsapp/outbox`, { headers: headers() });
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }
  if (data.holdUntil) {
    log(`quiet gap active — holding ${data.queued ?? "queued"} item(s) until ${data.holdUntil}`);
    return;
  }
  for (const msg of data.messages ?? []) {
    const digits = String(msg.to || data.founderNumber || "").replace(/[^\d]/g, "");
    if (!digits) continue;
    const jid = `${digits}@s.whatsapp.net`;
    const ids = Array.isArray(msg.ids) && msg.ids.length ? msg.ids : [msg.id].filter(Boolean);
    const ackUrl = `${EXEC_URL}/api/whatsapp/outbox/${encodeURIComponent(ids[0] ?? "unknown")}/ack`;
    try {
      await sock.sendMessage(jid, { text: msg.text });
      await fetch(ackUrl, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ status: "SENT", ids }),
      });
      log(`delivered (${msg.itemCount ?? "?"} item(s), ${ids.length} queued) → ${digits}`);
    } catch (err) {
      const errText = String(err?.message ?? err).slice(0, 200);
      await fetch(ackUrl, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ status: "FAILED", error: errText, ids }),
      }).catch(() => {});
      log(`delivery FAILED → ${digits}: ${errText}`);
    }
  }
}

log(`Zarlino WhatsApp Bridge starting — OS at ${EXEC_URL}`);
void connect();
