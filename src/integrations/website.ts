/**
 * Website tools for the Executive — live health checks against the public
 * Zarlino site (zarlinoaudio.com). Read-only, LOW risk.
 */
import { z } from "zod";
import type { Tool, ToolContext } from "../core/tools/types";

const DEFAULT_PAGES = ["/", "/plugins/ztame", "/plugins/zscorch", "/report", "/checkout"];

export function websiteTools(env: Record<string, string | undefined>): Tool[] {
  const base = () => (env.WEBSITE_URL ?? "https://zarlinoaudio.com").replace(/\/$/, "");
  return [
    {
      name: "website.status",
      description: "Probe the Zarlino website's key pages and report live HTTP status for each. Useful after a deploy.",
      inputSchema: z.object({ paths: z.array(z.string().max(200)).max(20).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (_ctx: ToolContext, input: { paths?: string[] }) => {
        const paths = input.paths?.length ? input.paths : DEFAULT_PAGES;
        const results = await Promise.all(
          paths.map(async (p) => {
            const url = `${base()}${p.startsWith("/") ? p : `/${p}`}`;
            try {
              const r = await fetch(url, { method: "GET", redirect: "follow" });
              return { path: p, url, status: r.status, ok: r.ok };
            } catch {
              return { path: p, url, status: 0, ok: false, error: "unreachable" };
            }
          }),
        );
        return { base: base(), checkedAt: new Date().toISOString(), pages: results, ok: results.every((r) => r.ok) };
      },
    },
  ];
}
