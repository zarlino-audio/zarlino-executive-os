/**
 * Founder notifications over WhatsApp — the CEO agent's ONLY window to the
 * human. Three providers are supported; the default (callmebot) needs just a
 * phone number + API key, no business account:
 *
 *   WHATSAPP_PROVIDER=callmebot  WHATSAPP_TO=+233…  WHATSAPP_APIKEY=…
 *   WHATSAPP_PROVIDER=twilio     TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM
 *   WHATSAPP_PROVIDER=meta       META_WHATSAPP_TOKEN / META_PHONE_NUMBER_ID
 *
 * When nothing is configured the message is still RECORDED (notifications
 * table, status QUEUED_UNCONFIGURED) so the founder can see exactly what the
 * OS wanted to tell them — delivery state is never faked.
 */
import type { ExecutiveStore } from "../db/store";
import { newId, nowIso } from "../ids";

export interface NotifyEnv {
  WHATSAPP_PROVIDER?: string;
  WHATSAPP_TO?: string;
  WHATSAPP_APIKEY?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_WHATSAPP_FROM?: string;
  META_WHATSAPP_TOKEN?: string;
  META_PHONE_NUMBER_ID?: string;
}

export interface SendResult {
  sent: boolean;
  provider: string;
  error?: string;
}

export async function sendWhatsApp(env: NotifyEnv, text: string): Promise<SendResult> {
  const provider = (env.WHATSAPP_PROVIDER || "").toLowerCase().trim();
  const to = (env.WHATSAPP_TO || "").trim();
  if (!provider || !to) {
    return { sent: false, provider: "unconfigured", error: "WHATSAPP_PROVIDER / WHATSAPP_TO not set" };
  }
  try {
    if (provider === "callmebot") {
      if (!env.WHATSAPP_APIKEY) return { sent: false, provider, error: "WHATSAPP_APIKEY not set" };
      const url =
        `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(to)}` +
        `&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(env.WHATSAPP_APIKEY)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const body = await res.text().catch(() => "");
      if (!res.ok || /error|invalid|not allowed/i.test(body)) {
        return { sent: false, provider, error: `callmebot HTTP ${res.status}: ${body.slice(0, 140)}` };
      }
      return { sent: true, provider };
    }
    if (provider === "twilio") {
      const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_WHATSAPP_FROM: from } = env;
      if (!sid || !token || !from) {
        return { sent: false, provider, error: "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM incomplete" };
      }
      const form = new URLSearchParams({ From: `whatsapp:${from}`, To: `whatsapp:${to}`, Body: text });
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { sent: false, provider, error: `twilio HTTP ${res.status}: ${body.slice(0, 140)}` };
      }
      return { sent: true, provider };
    }
    if (provider === "meta") {
      const { META_WHATSAPP_TOKEN: token, META_PHONE_NUMBER_ID: phoneId } = env;
      if (!token || !phoneId) {
        return { sent: false, provider, error: "META_WHATSAPP_TOKEN / META_PHONE_NUMBER_ID incomplete" };
      }
      const res = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(phoneId)}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { sent: false, provider, error: `meta HTTP ${res.status}: ${body.slice(0, 140)}` };
      }
      return { sent: true, provider };
    }
    return { sent: false, provider, error: `unknown provider '${provider}'` };
  } catch (err) {
    return { sent: false, provider, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface EscalationResult {
  sent: boolean;
  provider: string;
  notificationId: string;
  status: string;
  error?: string;
}

/** Record + deliver one founder escalation. Never throws. */
export async function escalateToFounder(
  store: ExecutiveStore,
  env: NotifyEnv,
  input: { subject: string; body: string; source?: string; priority?: string },
): Promise<EscalationResult> {
  const text = `${input.subject}\n\n${input.body}`;
  const r = await sendWhatsApp(env, text);
  const status = r.sent ? "SENT" : r.provider === "unconfigured" ? "QUEUED_UNCONFIGURED" : "FAILED";
  const id = newId("ntf");
  store.insertNotification({
    id,
    channel: "whatsapp",
    provider: r.provider,
    recipient: (env.WHATSAPP_TO ?? null) || null,
    subject: input.subject,
    body: input.body,
    status,
    error: r.error ?? null,
    source: input.source ?? "ceo",
    created_at: nowIso(),
  });
  return { sent: r.sent, provider: r.provider, notificationId: id, status, error: r.error };
}
