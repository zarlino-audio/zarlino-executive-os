/**
 * Zarlino inbound mail worker.
 *
 * Cloudflare Email Routing sends support@zarlinoaudio.com here. We forward the
 * message to the Executive OS (classified + stored, opt-outs enforced), then
 * forward it on to the founder's real inbox. Mail is NEVER dropped: if the OS
 * is unreachable the forward still happens.
 *
 * Secrets (wrangler secret put):
 *   EXEC_INTERNAL_SECRET  — same value as the exec-os INTERNAL_SECRET
 * Vars (wrangler.toml):
 *   OS_URL, FORWARD_TO
 */
function extractTextBody(raw) {
  const idx = raw.search(/\r?\n\r?\n/);
  let body = idx >= 0 ? raw.slice(idx + 2) : raw;
  // Strip simple HTML if the body looks like markup.
  if (/<[a-z][\s\S]*>/i.test(body)) {
    body = body
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ");
  }
  return body.replace(/\s+/g, " ").trim();
}

export default {
  async email(message, env, ctx) {
    let posted = false;
    try {
      const raw = await new Response(message.raw).text();
      const subject = message.headers.get("subject") || "";
      const messageId = message.headers.get("message-id") || "";
      const body = extractTextBody(raw).slice(0, 4000);
      const res = await fetch(`${env.OS_URL}/api/outreach/reply`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-exec-internal": env.EXEC_INTERNAL_SECRET || "",
        },
        body: JSON.stringify({ from: message.from, subject, messageId, body }),
      });
      posted = res.ok;
      if (!res.ok) console.log(`reply bridge: OS responded ${res.status}`);
    } catch (e) {
      console.log(`reply bridge error: ${String(e)}`);
    }
    try {
      await message.forward(env.FORWARD_TO);
    } catch (e) {
      console.log(`forward failed: ${String(e)}`);
    }
    console.log(JSON.stringify({ posted, from: message.from, to: message.to }));
  },
};
