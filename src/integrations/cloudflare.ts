/**
 * Cloudflare integration for the Executive (uses CF_API_TOKEN, optional).
 * Read-only account/zone tools are LOW risk; cache purge is a mutation and is
 * HIGH risk (the worker layer must gate it behind Founder approval).
 */
import { z } from "zod";
import type { Tool, ToolContext } from "../core/tools/types";

const API = "https://api.cloudflare.com/client/v4";

export function cloudflareTools(env: Record<string, string | undefined>): Tool[] {
  const token = () => env.CF_API_TOKEN ?? "";
  return [
    {
      name: "cloudflare.list_zones",
      description: "List Cloudflare zones visible to the configured token (name + status). Read-only.",
      inputSchema: z.object({ name: z.string().max(200).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (_ctx: ToolContext, input: { name?: string }) => {
        if (!token()) return { configured: false, note: "CF_API_TOKEN not configured." };
        const res = await fetch(`${API}/zones?per_page=50${input.name ? `&name=${encodeURIComponent(input.name)}` : ""}`, {
          headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
        });
        if (!res.ok) return { configured: true, error: `Cloudflare ${res.status}: ${(await res.text()).slice(0, 200)}` };
        const data = (await res.json()) as { success?: boolean; result?: Array<{ id: string; name: string; status: string }> };
        return {
          configured: true,
          count: (data.result ?? []).length,
          zones: (data.result ?? []).map((z) => ({ id: z.id, name: z.name, status: z.status })),
        };
      },
    },
    {
      name: "cloudflare.purge_cache",
      description: "Purge the cache for a Cloudflare zone by zone id (or all cache). HIGH RISK — requires Founder approval before execution.",
      inputSchema: z.object({
        zoneId: z.string().min(1).max(64),
        files: z.array(z.string().max(2000)).max(50).optional(),
        purgeEverything: z.boolean().optional(),
      }),
      requiredPermission: "execute",
      riskLevel: "HIGH",
      reversible: false,
      auditRequired: true,
      run: async (_ctx: ToolContext, input: { zoneId: string; files?: string[]; purgeEverything?: boolean }) => {
        if (!token()) return { configured: false, note: "CF_API_TOKEN not configured." };
        const body = input.purgeEverything ? { purge_everything: true } : { files: input.files ?? [] };
        const res = await fetch(`${API}/zones/${encodeURIComponent(input.zoneId)}/purge_cache`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) return { configured: true, error: `Cloudflare ${res.status}: ${(await res.text()).slice(0, 300)}` };
        const data = (await res.json()) as { success?: boolean; result?: { id?: string } };
        return { configured: true, success: data.success ?? false, purgeId: data.result?.id ?? null, purgeEverything: Boolean(input.purgeEverything) };
      },
    },
  ];
}
