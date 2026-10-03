/**
 * YouTube integration (prospect sourcing for the affiliate outreach pipeline).
 *
 * Uses the YouTube Data API v3 with a plain API key (YOUTUBE_API_KEY secret).
 * Read-only, LOW risk. Quota note: a search costs 100 units of the default
 * 10,000/day, so `prospect_candidates` with maxResults<=15 stays cheap.
 *
 * HONESTY RULE: this integration only surfaces what a channel publishes
 * publicly (description text). It never guesses addresses — every candidate
 * still gets a human/agent review before being added as a prospect.
 */
import { z } from "zod";
import type { Tool, ToolContext } from "../core/tools/types";

const API = "https://www.googleapis.com/youtube/v3";

/** Pull emails + links out of a channel description (public text only). */
export function extractContacts(text: string | undefined | null): { emails: string[]; links: string[] } {
  const t = String(text ?? "");
  const emails = Array.from(
    new Set((t.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []).map((s) => s.toLowerCase())),
  ).filter((e) => !/\.(png|jpe?g|gif|webp|svg)$/i.test(e));
  const links = Array.from(new Set(t.match(/https?:\/\/[^\s)"'\]>,]+/g) ?? [])).slice(0, 10);
  return { emails, links };
}

interface YtChannel {
  id: string;
  snippet?: { title?: string; description?: string; customUrl?: string; country?: string };
  statistics?: { subscriberCount?: string; videoCount?: string; viewCount?: string };
  brandingSettings?: { channel?: { keywords?: string; country?: string } };
}

function mapChannel(c: YtChannel) {
  const description = String(c.snippet?.description ?? "");
  const { emails, links } = extractContacts(description);
  return {
    channelId: c.id,
    title: c.snippet?.title ?? "",
    handle: c.snippet?.customUrl ?? null,
    country: c.snippet?.country ?? c.brandingSettings?.channel?.country ?? null,
    subscribers: Number(c.statistics?.subscriberCount ?? 0),
    videos: Number(c.statistics?.videoCount ?? 0),
    description: description.slice(0, 1200),
    emails,
    links,
  };
}

export function youtubeTools(env: Record<string, string | undefined>): Tool[] {
  const key = () => String(env.YOUTUBE_API_KEY ?? "").trim();

  async function ytGet(pathname: string, params: Record<string, string>): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
    const qs = new URLSearchParams({ ...params, key: key() });
    const res = await fetch(`${API}/${pathname}?${qs.toString()}`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: `YouTube ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true, status: res.status, data: await res.json() };
  }

  return [
    {
      name: "youtube.search_channels",
      description: "Search YouTube channels by keyword (read-only). Returns channel ids, titles, truncated descriptions.",
      inputSchema: z.object({ query: z.string().min(1).max(200), maxResults: z.number().int().min(1).max(25).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (_ctx: ToolContext, input: { query: string; maxResults?: number }) => {
        if (!key()) return { configured: false, note: "YOUTUBE_API_KEY not configured." };
        const r = await ytGet("search", {
          part: "snippet",
          type: "channel",
          q: input.query,
          maxResults: String(input.maxResults ?? 10),
        });
        if (!r.ok) return { configured: true, error: r.error };
        const data = r.data as { items?: Array<{ id?: { channelId?: string }; snippet?: { title?: string; description?: string } }> };
        return {
          configured: true,
          count: (data.items ?? []).length,
          channels: (data.items ?? []).map((i) => ({
            channelId: i.id?.channelId ?? "",
            title: i.snippet?.title ?? "",
            description: String(i.snippet?.description ?? "").slice(0, 300),
          })),
        };
      },
    },
    {
      name: "youtube.channel",
      description: "Channel details by id or @handle (read-only): stats + FULL description with emails/links extracted.",
      inputSchema: z.object({ channelId: z.string().min(3).max(64).optional(), handle: z.string().min(1).max(80).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (_ctx: ToolContext, input: { channelId?: string; handle?: string }) => {
        if (!key()) return { configured: false, note: "YOUTUBE_API_KEY not configured." };
        if (!input.channelId && !input.handle) return { error: "channelId or handle required" };
        const params: Record<string, string> = { part: "snippet,statistics,brandingSettings" };
        if (input.channelId) params.id = input.channelId;
        if (input.handle) params.forHandle = input.handle.startsWith("@") ? input.handle : `@${input.handle}`;
        const r = await ytGet("channels", params);
        if (!r.ok) return { configured: true, error: r.error };
        const data = r.data as { items?: YtChannel[] };
        const first = (data.items ?? [])[0];
        if (!first) return { configured: true, found: false };
        return { configured: true, found: true, channel: mapChannel(first) };
      },
    },
    {
      name: "youtube.prospect_candidates",
      description:
        "Prospect sourcing: search channels, enrich with stats + public description contacts (emails/links). Output is a REVIEW list — verify and add via outreach.add_prospect, never auto-send.",
      inputSchema: z.object({ query: z.string().min(1).max(200), maxResults: z.number().int().min(1).max(15).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (_ctx: ToolContext, input: { query: string; maxResults?: number }) => {
        if (!key()) return { configured: false, note: "YOUTUBE_API_KEY not configured." };
        const search = await ytGet("search", {
          part: "snippet",
          type: "channel",
          q: input.query,
          maxResults: String(input.maxResults ?? 10),
        });
        if (!search.ok) return { configured: true, error: search.error };
        const sdata = search.data as { items?: Array<{ id?: { channelId?: string } }> };
        const ids = Array.from(new Set((sdata.items ?? []).map((i) => i.id?.channelId ?? "").filter(Boolean)));
        if (!ids.length) return { configured: true, count: 0, candidates: [] };
        const details = await ytGet("channels", { part: "snippet,statistics,brandingSettings", id: ids.join(",") });
        if (!details.ok) return { configured: true, error: details.error };
        const ddata = details.data as { items?: YtChannel[] };
        return {
          configured: true,
          note: "Review each candidate; only publicly listed contacts are shown. Add approved ones via outreach.add_prospect.",
          count: (ddata.items ?? []).length,
          candidates: (ddata.items ?? []).map(mapChannel),
        };
      },
    },
  ];
}
