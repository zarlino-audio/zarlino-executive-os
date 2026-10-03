import { describe, it, expect, vi, afterEach } from "vitest";
import { extractContacts, youtubeTools } from "../src/integrations/youtube";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Call a tool's run with a dummy context. */
async function runTool(env: Record<string, string | undefined>, name: string, input: unknown) {
  const tool = youtubeTools(env).find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return (tool.run as unknown as (c: unknown, i: unknown) => Promise<unknown>)({}, input);
}

describe("youtube integration", () => {
  it("extracts emails and links from public channel descriptions", () => {
    const { emails, links } = extractContacts(
      "Beats & tutorials. Business: beats@Example.com. Logo: art@brand.png. More at https://example.com/contact and http://linktr.ee/artist",
    );
    expect(emails).toEqual(["beats@example.com"]);
    expect(links).toContain("https://example.com/contact");
    expect(links).toContain("http://linktr.ee/artist");
  });

  it("reports configured:false without an API key", async () => {
    const res = (await runTool({}, "youtube.search_channels", { query: "afrobeats" })) as { configured: boolean };
    expect(res.configured).toBe(false);
  });

  it("searches channels and maps the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          items: [{ id: { channelId: "UCabc" }, snippet: { title: "Beat Channel", description: "hi" } }],
        }),
      })),
    );
    const res = (await runTool({ YOUTUBE_API_KEY: "k" }, "youtube.search_channels", { query: "afrobeats producers" })) as {
      configured: boolean;
      channels: Array<{ channelId: string; title: string }>;
    };
    expect(res.configured).toBe(true);
    expect(res.channels[0]).toEqual({ channelId: "UCabc", title: "Beat Channel", description: "hi" });
  });

  it("prospect_candidates enriches channels with contacts", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/search")) {
        return { ok: true, json: async () => ({ items: [{ id: { channelId: "UCabc" } }] }) };
      }
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              id: "UCabc",
              snippet: { title: "Producer X", description: "Bookings: mgmt@producerx.com", customUrl: "@producerx" },
              statistics: { subscriberCount: "12345", videoCount: "88" },
            },
          ],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = (await runTool({ YOUTUBE_API_KEY: "k" }, "youtube.prospect_candidates", { query: "producer" })) as {
      candidates: Array<{ emails: string[]; subscribers: number; handle: string | null }>;
    };
    expect(res.candidates[0]?.emails).toEqual(["mgmt@producerx.com"]);
    expect(res.candidates[0]?.subscribers).toBe(12345);
    expect(res.candidates[0]?.handle).toBe("@producerx");
  });
});
