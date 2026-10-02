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
import os from "node:os";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const EXEC_URL = (process.env.EXEC_URL || "https://os.zarlinoaudio.com").replace(/\/$/, "");
const QR_PORT = Number(process.env.QR_PORT || 3037);
const POLL_MS = Number(process.env.OUTBOX_POLL_MS || 15000);
const logger = P({ level: "silent" });

// Baileys' signal layer dumps raw session objects and Bad-MAC chatter on the
// console. Drop the dumps, but keep a COMPACT warning when a message fails to
// decrypt — that line is the difference between "nothing arrived" and
// "arrived but couldn't be read" during diagnosis.
const NOISE_DROP = ["Closing session", "Closing open session", "Session error"];
const quiet = (orig) =>
  (...args) => {
    const first = typeof args[0] === "string" ? args[0] : "";
    if (NOISE_DROP.some((p) => first.startsWith(p))) return;
    if (first.startsWith("Failed to decrypt message")) {
      orig(`[${new Date().toISOString()}] [warn] a message couldn't be decrypted — requesting retry from WhatsApp`);
      return;
    }
    orig(...args);
  };
console.log = quiet(console.log.bind(console));
console.error = quiet(console.error.bind(console));

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

/**
 * Every OS call goes through here: explicit 20s timeout + retries with
 * backoff. This machine's uplink is flaky (transient 408s, multi-second
 * stalls) — one dropped fetch must never mean a dropped founder message.
 */
async function osFetch(pathname, options = {}, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fetch(`${EXEC_URL}${pathname}`, { ...options, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      lastErr = err;
      log(`OS fetch ${pathname} attempt ${i}/${tries} failed: ${err?.message ?? err}`);
      if (i < tries) await new Promise((r) => setTimeout(r, 2500 * i));
    }
  }
  throw lastErr;
}

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
let heartbeatTimer = null;

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
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => void postHeartbeat(), 60_000);
      void drainOutbox();
      void postHeartbeat();
    }
    if (u.connection === "close") {
      const code = u.lastDisconnect?.error?.output?.statusCode ?? u.lastDisconnect?.error?.message;
      if (drainTimer) {
        clearInterval(drainTimer);
        drainTimer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
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
    log(`upsert: ${messages.length} new message(s)`);
    for (const m of messages) {
      try {
        const jid = m.key?.remoteJid || "";
        if (m.key?.fromMe) {
          log(`skip: own outgoing message (${jid || "self"})`);
          continue;
        }
        if (!m.message) {
          log(`skip: no message body (${jid || "unknown"})`);
          continue;
        }
        if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") {
          log(`skip: group/status (${jid || "unknown"})`);
          continue;
        }
        const text =
          m.message.conversation ||
          m.message.extendedTextMessage?.text ||
          m.message.imageMessage?.caption ||
          m.message.videoMessage?.caption ||
          "";
        if (!text.trim()) {
          log(`skip: no text content (${jid})`);
          continue;
        }
        // WhatsApp's LID migration: remoteJid may be a <lid>@lid identifier
        // that is NOT the phone number. Prefer the phone-number JID
        // (remoteJidAlt/senderPn) for classification; reply to the original.
        const alt = m.key?.remoteJidAlt || m.key?.senderPn || "";
        const pnJid = jid.endsWith("@s.whatsapp.net") ? jid : String(alt).endsWith("@s.whatsapp.net") ? String(alt) : "";
        const from = (pnJid || jid).split("@")[0].split(":")[0];
        log(`inbound text from ${from}${pnJid ? "" : " (no phone-number JID — LID only)"} (${text.length} chars) — asking the OS`);
        const res = await osFetch("/api/whatsapp/inbound", {
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
          try {
            await sock.sendMessage(jid, { text: data.reply });
            log(`[${data.role}] replied to ${from}`);
          } catch (sendErr) {
            log(`[${data.role}] SEND FAILED to ${from}: ${sendErr?.message ?? sendErr}`);
          }
        } else {
          log(`[${data.role}] ${from}: no reply (duplicate=${data.duplicate})`);
        }
      } catch (err) {
        log(`message error: ${err?.message ?? err}`);
      }
    }
  });
}

// ---- Liveness heartbeat -----------------------------------------------------
/**
 * Tells the OS which machine currently hosts the founder channel (settings
 * key whatsapp_bridge_last_seen). The doctor turns that into a real check, so
 * "the bridge died with the old laptop" is visible in the cloud instead of
 * silently queueing messages.
 */
async function postHeartbeat() {
  if (status !== "linked") return;
  try {
    await osFetch(
      "/api/whatsapp/bridge/heartbeat",
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ host: os.hostname(), linkedAs }),
      },
      2,
    );
  } catch {
    /* best-effort; message delivery is the priority */
  }
}

// ---- Outbox drain (founder escalations) ------------------------------------
async function drainOutbox() {
  if (!sock || status !== "linked") return;
  let data;
  try {
    const res = await osFetch("/api/whatsapp/outbox", { headers: headers() }, 2);
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
    const ackPath = `/api/whatsapp/outbox/${encodeURIComponent(ids[0] ?? "unknown")}/ack`;
    try {
      await sock.sendMessage(jid, { text: msg.text });
      await osFetch(ackPath, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ status: "SENT", ids }),
      }, 3);
      log(`delivered (${msg.itemCount ?? "?"} item(s), ${ids.length} queued) → ${digits}`);
    } catch (err) {
      const errText = String(err?.message ?? err).slice(0, 200);
      await osFetch(ackPath, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ status: "FAILED", error: errText, ids }),
      }, 2).catch(() => {});
      log(`delivery FAILED → ${digits}: ${errText}`);
    }
  }
}

log(`Zarlino WhatsApp Bridge starting — OS at ${EXEC_URL}`);
void connect();
