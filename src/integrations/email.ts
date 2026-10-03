/**
 * Outbound email (Phase 1 growth). Provider-agnostic over HTTPS — Cloudflare
 * Workers cannot speak SMTP, so everything goes through a provider REST API.
 *
 * Configure on the exec-os Worker:
 *   EMAIL_PROVIDER   "brevo" | "mailjet"
 *   EMAIL_API_KEY    secret (`wrangler secret put EMAIL_API_KEY`)
 *   EMAIL_FROM       verified sender address (e.g. support@zarlinoaudio.com)
 *   EMAIL_FROM_NAME  display name (e.g. "Zarlino Audio")
 *   EMAIL_REPLY_TO   optional reply-to address
 *
 * When not configured, `emailConfigured` is false and sendEmail refuses —
 * callers must treat that as "skip", never as a failure of the prospect.
 */

export interface EmailEnv {
  EMAIL_PROVIDER?: string;
  EMAIL_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_FROM_NAME?: string;
  EMAIL_REPLY_TO?: string;
}

export function emailConfigured(env: EmailEnv): boolean {
  return Boolean(env.EMAIL_API_KEY && env.EMAIL_FROM && String(env.EMAIL_PROVIDER ?? "").trim());
}

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SendEmailResult {
  ok: boolean;
  provider?: string;
  id?: string;
  error?: string;
}

export async function sendEmail(env: EmailEnv, msg: SendEmailInput): Promise<SendEmailResult> {
  const provider = String(env.EMAIL_PROVIDER ?? "").trim().toLowerCase();
  if (!emailConfigured(env)) {
    return { ok: false, error: "email provider not configured (EMAIL_PROVIDER/EMAIL_API_KEY/EMAIL_FROM)" };
  }
  const sender = { email: env.EMAIL_FROM!, name: env.EMAIL_FROM_NAME ?? "Zarlino Audio" };
  try {
    if (provider === "brevo") {
      const r = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": env.EMAIL_API_KEY!, "content-type": "application/json" },
        body: JSON.stringify({
          sender,
          to: [{ email: msg.to }],
          subject: msg.subject,
          textContent: msg.text,
          htmlContent: msg.html ?? undefined,
          replyTo: env.EMAIL_REPLY_TO ? { email: env.EMAIL_REPLY_TO } : undefined,
        }),
      });
      if (!r.ok) {
        const detail = (await r.text().catch(() => "")).slice(0, 200);
        return { ok: false, provider, error: `brevo HTTP ${r.status}: ${detail}` };
      }
      const j = (await r.json().catch(() => ({}))) as { messageId?: string };
      return { ok: true, provider, id: j.messageId };
    }
    if (provider === "mailjet") {
      const [keyPart, secretPart] = String(env.EMAIL_API_KEY ?? "").split(":");
      const auth = btoa(`${keyPart ?? ""}:${secretPart ?? ""}`);
      const r = await fetch("https://api.mailjet.com/v3.1/send", {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "content-type": "application/json" },
        body: JSON.stringify({
          Messages: [
            {
              From: { Email: sender.email, Name: sender.name },
              To: [{ Email: msg.to }],
              Subject: msg.subject,
              TextPart: msg.text,
            },
          ],
        }),
      });
      if (!r.ok) {
        const detail = (await r.text().catch(() => "")).slice(0, 200);
        return { ok: false, provider, error: `mailjet HTTP ${r.status}: ${detail}` };
      }
      return { ok: true, provider };
    }
    return { ok: false, error: `unknown EMAIL_PROVIDER '${provider}'` };
  } catch (e) {
    return { ok: false, provider, error: String(e).slice(0, 200) };
  }
}
