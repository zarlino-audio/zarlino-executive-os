/**
 * GitHub integration for the Executive. Uses GITHUB_TOKEN (optional): without
 * it, tools return a clear "not configured" message. Read-only tools are LOW
 * risk; creating issues is a mutation (audited) but reversible-ish and safe.
 */
import { z } from "zod";
import type { Tool, ToolContext } from "../core/tools/types";

const API = "https://api.github.com";
const DEFAULT_REPO = "zarlino-audio/zarlino-website";

function headers(env: Record<string, string | undefined>): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "zarlino-executive-os",
  };
  if (env.GITHUB_TOKEN) h.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return h;
}

export function githubTools(env: Record<string, string | undefined>): Tool[] {
  return [
    {
      name: "github.list_issues",
      description: "List open issues for a GitHub repo (default: zarlino-audio/zarlino-website). Read-only.",
      inputSchema: z.object({ repo: z.string().max(200).optional(), state: z.enum(["open", "closed", "all"]).optional(), limit: z.number().int().min(1).max(50).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (_ctx: ToolContext, input: { repo?: string; state?: "open" | "closed" | "all"; limit?: number }) => {
        if (!env.GITHUB_TOKEN) return { configured: false, note: "GITHUB_TOKEN not configured." };
        const repo = input.repo ?? DEFAULT_REPO;
        const res = await fetch(`${API}/repos/${repo}/issues?state=${input.state ?? "open"}&per_page=${input.limit ?? 20}`, { headers: headers(env) });
        if (!res.ok) return { configured: true, error: `GitHub ${res.status}: ${(await res.text()).slice(0, 200)}` };
        const issues = (await res.json()) as Array<{ number: number; title: string; state: string; html_url: string; created_at: string; labels: Array<{ name: string }> }>;
        return {
          configured: true,
          repo,
          count: issues.length,
          issues: issues.map((i) => ({ number: i.number, title: i.title, state: i.state, url: i.html_url, createdAt: i.created_at, labels: i.labels.map((l) => l.name) })),
        };
      },
    },
    {
      name: "github.create_issue",
      description: "Create an issue in a GitHub repo (default: zarlino-audio/zarlino-feedback). Audited mutation.",
      inputSchema: z.object({
        repo: z.string().max(200).optional(),
        title: z.string().min(1).max(300),
        body: z.string().max(5000).optional(),
        labels: z.array(z.string().max(40)).max(10).optional(),
      }),
      requiredPermission: "modify",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: true,
      run: async (_ctx: ToolContext, input: { repo?: string; title: string; body?: string; labels?: string[] }) => {
        if (!env.GITHUB_TOKEN) return { configured: false, note: "GITHUB_TOKEN not configured." };
        const repo = input.repo ?? "zarlino-audio/zarlino-feedback";
        const res = await fetch(`${API}/repos/${repo}/issues`, {
          method: "POST",
          headers: { ...headers(env), "Content-Type": "application/json" },
          body: JSON.stringify({ title: input.title, body: input.body ?? "", labels: input.labels ?? [] }),
        });
        if (!res.ok) return { configured: true, error: `GitHub ${res.status}: ${(await res.text()).slice(0, 300)}` };
        const data = (await res.json()) as { number?: number; html_url?: string };
        return { configured: true, repo, number: data.number, url: data.html_url ?? "" };
      },
    },
    {
      name: "github.list_workflow_runs",
      description: "List recent GitHub Actions workflow runs for a repo (default: zarlino-audio/zarlino-website). Read-only.",
      inputSchema: z.object({ repo: z.string().max(200).optional(), limit: z.number().int().min(1).max(20).optional() }),
      requiredPermission: "read",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (_ctx: ToolContext, input: { repo?: string; limit?: number }) => {
        if (!env.GITHUB_TOKEN) return { configured: false, note: "GITHUB_TOKEN not configured." };
        const repo = input.repo ?? DEFAULT_REPO;
        const res = await fetch(`${API}/repos/${repo}/actions/runs?per_page=${input.limit ?? 5}`, { headers: headers(env) });
        if (!res.ok) return { configured: true, error: `GitHub ${res.status}: ${(await res.text()).slice(0, 200)}` };
        const data = (await res.json()) as { workflow_runs?: Array<{ name: string; status: string; conclusion: string | null; head_branch: string; created_at: string; html_url: string }> };
        return {
          configured: true,
          repo,
          runs: (data.workflow_runs ?? []).map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, branch: r.head_branch, createdAt: r.created_at, url: r.html_url })),
        };
      },
    },
  ];
}
