import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry, sanitizeToolName } from "../src/core/tools/registry";
import type { Tool } from "../src/core/tools/types";

function makeTool(name: string): Tool {
  return {
    name,
    description: `tool ${name}`,
    inputSchema: z.object({ q: z.string().optional() }),
    requiredPermission: "read",
    riskLevel: "LOW",
    reversible: true,
    auditRequired: false,
    run: async () => ({ ok: true, from: name }),
  };
}

describe("ToolRegistry provider-safe names (DeepSeek dot rule)", () => {
  const registry = new ToolRegistry({ recordExecution: () => {} });
  registry.register(makeTool("finance.get_snapshot"));
  registry.register(makeTool("productivity.report"));
  registry.register(makeTool("system.doctor"));
  registry.register(makeTool("simple_tool"));

  it("sanitizes dotted names for the wire (dots → underscores)", () => {
    expect(sanitizeToolName("finance.get_snapshot")).toBe("finance_get_snapshot");
    expect(sanitizeToolName("simple_tool")).toBe("simple_tool");
    expect(sanitizeToolName("a.b-c_d")).toBe("a_b-c_d");
  });

  it("functionSchemas returns only provider-safe names matching ^[a-zA-Z0-9_-]+$", () => {
    const schemas = registry.functionSchemas();
    expect(schemas.length).toBe(4);
    for (const s of schemas) {
      expect(s.function.name).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(s.function.parameters).toBeTruthy();
    }
    const names = schemas.map((s) => s.function.name);
    expect(names).toContain("finance_get_snapshot");
    expect(names).toContain("productivity_report");
  });

  it("resolveName maps a sanitized name back to the real tool", () => {
    expect(registry.resolveName("finance_get_snapshot")).toBe("finance.get_snapshot");
    expect(registry.resolveName("system_doctor")).toBe("system.doctor");
    expect(registry.resolveName("simple_tool")).toBe("simple_tool");
    // Unknown names pass through unchanged.
    expect(registry.resolveName("nope")).toBe("nope");
  });

  it("still runs tools by their real dotted name", async () => {
    const r = await registry.run("finance.get_snapshot", {}, { env: {} });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.output as { from: string }).from).toBe("finance.get_snapshot");
  });
});
