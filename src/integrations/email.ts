/**
 * Outbound email (Phase 1 growth). Provider-agnostic over HTTPS — Cloudflare
 * Workers cannot speak SMTP, so everything goes through a provider REST API.
 *
 * Providers:
 *   "cloudflare"  Email Sending binding (wrangler.toml [[send_email]] name "SEND_EMAIL")
 *   "brevo"       REST API (requires the EMAIL_API_KEY secret)
 *   "mailjet"     REST API (requires the EMAIL_API_KEY secret, "key:secret")
 *
 * Configure on the exec-os Worker:
 *   EMAIL_PROVIDER   "cloudflare" | "brevo" | "mailjet"
 *   EMAIL_FROM       sender address (verified/onboarded for the provider)
 *   EMAIL_FROM_NAME  display name (e.g. "Zarlino Audio")
 *   EMAIL_REPLY_TO   optional reply-to address
 *   EMAIL_API_KEY    secret - only for brevo/mailjet
 *   SEND_EMAIL       binding - only for cloudflare
 *
 * When not configured, `emailConfigured` is false and sendEmail refuses —
 * callers must treat that as "skip", never as a failure of the prospect.
 */

export interface SendEmailAddress {
  email: string;
  name?: string;
}

/** Minimal structural type of the Cloudflare `send_email` binding. */
export interface SendEmailBinding {
  send(message: {
    to: string | SendEmailAddress | Array<string | SendEmailAddress>;
    from: string | SendEmailAddress;
    subject: string;
    text?: string;
    html?: string;
    replyTo?: string | SendEmailAddress;
  }): Promise<{ messageId?: string } | undefined>;
}

export function asSendEmailBinding(v: unknown): SendEmailBinding | undefined {
  const b = v as SendEmailBinding | undefined;
  return b && typeof b.send === "function" ? b : undefined;
}

export interface EmailEnv {
  EMAIL_PROVIDER?: string;
  EMAIL_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_FROM_NAME?: string;
  EMAIL_REPLY_TO?: string;
  /** Cloudflare Email Sending binding (present when wrangler.toml declares it). */
  SEND_EMAIL?: unknown;
}

export function emailConfigured(env: EmailEnv): boolean {
  const provider = String(env.EMAIL_PROVIDER ?? "").trim().toLowerCase();
  if (!provider || !env.EMAIL_FROM) return false;
  if (provider === "cloudflare") return Boolean(asSendEmailBinding(env.SEND_EMAIL));
  return Boolean(env.EMAIL_API_KEY);
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
    return { ok: false, error: "email provider not configured (EMAIL_PROVIDER/EMAIL_FROM + key or binding)" };
  }
  const sender = { email: env.EMAIL_FROM!, name: env.EMAIL_FROM_NAME ?? "Zarlino Audio" };
  try {
    if (provider === "cloudflare") {
      const binding = asSendEmailBinding(env.SEND_EMAIL);
      if (!binding) return { ok: false, provider, error: "SEND_EMAIL binding missing" };
      try {
        const res = await binding.send({
          to: msg.to,
          from: env.EMAIL_FROM!,
          subject: msg.subject,
          text: msg.text,
          ...(msg.html ? { html: msg.html } : {}),
          ...(env.EMAIL_REPLY_TO ? { replyTo: env.EMAIL_REPLY_TO } : {}),
        });
        return { ok: true, provider, id: res?.messageId };
      } catch (e) {
        const code = (e as { code?: string } | null)?.code;
        return { ok: false, provider, error: `cloudflare ${code ?? "error"}: ${String(e).slice(0, 160)}` };
      }
    }
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
