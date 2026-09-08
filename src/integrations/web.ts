/**
 * General web tools for the Executive — search + fetch. Read-only, LOW risk.
 * Search uses DuckDuckGo HTML with a Wikipedia fallback (no API keys needed).
 */
import { z } from "zod";
import type { Tool, ToolContext } from "../core/tools/types";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function parseDdg(html: string, limit: number): string[] {
  if (/anomaly|challenge|unusual traffic/i.test(html)) return [];
  const results: string[] = [];
  const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const anchors = [...html.matchAll(anchorRe)];
  const snippets = [...html.matchAll(snippetRe)];
  for (let i = 0; i < anchors.length && results.length < limit; i++) {
    const m = anchors[i];
    if (!m) continue;
    let url = (m[1] ?? "").replace(/^\/\//, "https://");
    const uddg = /uddg=([^&]+)/.exec(url);
    if (uddg?.[1]) url = decodeURIComponent(uddg[1]);
    const title = (m[2] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
    const snippet = (snippets[i]?.[1] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
    results.push(`${i + 1}. ${title}\n   ${url}\n   ${snippet}`);
  }
  return results;
}

export function webTools(env: Record<string, string | undefined>): Tool[] {
  return [
    {
      name: "web.search",
      description: "Search the web (DuckDuckGo with Wikipedia fallback) and return top results with titles, URLs, snippets.",
      inputSchema: z.object({ query: z.string().min(1).max(300), limit: z.number().int().min(1).max(10).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (_ctx: ToolContext, input: { query: string; limit?: number }) => {
        const limit = input.limit ?? 6;
        const params = new URLSearchParams({ q: input.query });
        const ddgRes = await fetch(`https://html.duckduckgo.com/html/?${params}`, {
          headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
        });
        if (ddgRes.ok) {
          const results = parseDdg(await ddgRes.text(), limit);
          if (results.length) return { source: "duckduckgo", results };
        }
        try {
          const wikiParams = new URLSearchParams({
            action: "query", list: "search", srsearch: input.query, format: "json", srlimit: String(limit),
          });
          const wikiRes = await fetch(`https://en.wikipedia.org/w/api.php?${wikiParams}`, {
            headers: { "User-Agent": "ZarlinoExecOS/1.0 (zarlinoaudio.com; plugin research)", Accept: "application/json" },
          });
          if (wikiRes.ok) {
            const body = (await wikiRes.json()) as { query?: { search?: Array<{ title?: string; snippet?: string }> } };
            const rows = (body.query?.search ?? []).slice(0, limit);
            if (rows.length) {
              return {
                source: "wikipedia",
                results: rows.map((r) => ({
                  title: r.title ?? "",
                  url: `https://en.wikipedia.org/wiki/${encodeURIComponent((r.title ?? "").replace(/ /g, "_"))}`,
                  snippet: (r.snippet ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 300),
                })),
              };
            }
          }
        } catch {
          /* fall through */
        }
        return { source: "none", results: [], note: "No parseable results (search engine may be rate-limiting). Try a different phrasing." };
      },
    },
    {
      name: "web.fetch",
      description: "Fetch a URL and return its readable text content (HTML stripped, capped).",
      inputSchema: z.object({ url: z.string().url().max(2000), maxChars: z.number().int().min(500).max(100_000).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (_ctx: ToolContext, input: { url: string; maxChars?: number }) => {
        const res = await fetch(input.url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; zarlino-executive-os/1.0)", Accept: "text/html,text/plain;q=0.9,*/*;q=0.8" },
          redirect: "follow",
        });
        const text = await res.text();
        const max = input.maxChars ?? 20_000;
        const body = /<[a-z][\s\S]*>/i.test(text.slice(0, 1000))
          ? text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
          : text;
        return {
          url: input.url,
          status: res.status,
          contentType: res.headers.get("content-type") ?? "",
          content: body.length > max ? body.slice(0, max) + `\n…(truncated at ${max})` : body,
        };
      },
    },
  ];
}
