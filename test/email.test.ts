import { describe, it, expect } from "vitest";
import { emailConfigured, sendEmail, type EmailEnv, type SendEmailBinding } from "../src/integrations/email";

function fakeBinding(result: { messageId?: string } | Error): { binding: SendEmailBinding; calls: unknown[] } {
  const calls: unknown[] = [];
  const binding: SendEmailBinding = {
    async send(message) {
      calls.push(message);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { binding, calls };
}

describe("email integration", () => {
  it("cloudflare is configured from the binding + sender alone (no API key)", () => {
    const { binding } = fakeBinding({ messageId: "m1" });
    expect(
      emailConfigured({ EMAIL_PROVIDER: "cloudflare", EMAIL_FROM: "support@zarlinoaudio.com", SEND_EMAIL: binding }),
    ).toBe(true);
    expect(emailConfigured({ EMAIL_PROVIDER: "cloudflare", EMAIL_FROM: "support@zarlinoaudio.com" })).toBe(false);
  });

  it("brevo still requires an API key", () => {
    expect(emailConfigured({ EMAIL_PROVIDER: "brevo", EMAIL_FROM: "support@zarlinoaudio.com" })).toBe(false);
    expect(
      emailConfigured({ EMAIL_PROVIDER: "brevo", EMAIL_FROM: "support@zarlinoaudio.com", EMAIL_API_KEY: "x" }),
    ).toBe(true);
  });

  it("sends via the Cloudflare binding and returns the message id", async () => {
    const { binding, calls } = fakeBinding({ messageId: "msg-123" });
    const env: EmailEnv = {
      EMAIL_PROVIDER: "cloudflare",
      EMAIL_FROM: "support@zarlinoaudio.com",
      EMAIL_FROM_NAME: "Zarlino Audio",
      EMAIL_REPLY_TO: "support@zarlinoaudio.com",
      SEND_EMAIL: binding,
    };
    const res = await sendEmail(env, { to: "producer@example.com", subject: "Hello", text: "Body" });
    expect(res).toEqual({ ok: true, provider: "cloudflare", id: "msg-123" });
    expect(calls).toHaveLength(1);
    const sent = calls[0] as { from: string; replyTo?: string };
    expect(sent.from).toBe("support@zarlinoaudio.com");
    expect(sent.replyTo).toBe("support@zarlinoaudio.com");
  });

  it("maps Cloudflare error codes into the failure result", async () => {
    const err = Object.assign(new Error("sender not verified"), { code: "E_SENDER_NOT_VERIFIED" });
    const { binding } = fakeBinding(err);
    const res = await sendEmail(
      { EMAIL_PROVIDER: "cloudflare", EMAIL_FROM: "support@zarlinoaudio.com", SEND_EMAIL: binding },
      { to: "producer@example.com", subject: "Hello", text: "Body" },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("E_SENDER_NOT_VERIFIED");
  });
});
