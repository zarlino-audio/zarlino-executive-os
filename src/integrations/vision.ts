/**
 * Vision integration — image analysis via DeepSeek's OpenAI-compatible chat
 * endpoint (multimodal content block). Requires DEEPSEEK_API_KEY. The tool
 * degrades gracefully: if the provider rejects the image payload, it returns
 * the provider's message rather than crashing.
 */
import { z } from "zod";
import type { Tool, ToolContext } from "../core/tools/types";

const API = "https://api.deepseek.com/chat/completions";

export function visionTools(env: Record<string, string | undefined>): Tool[] {
  return [
    {
      name: "vision.analyze_image",
      description:
        "Analyze an image (screenshot, spectrogram, GUI render) with a vision model. Provide imageBase64 (no data: prefix) and mimeType (e.g. image/png). Returns the model's description or a clear provider error.",
      inputSchema: z.object({
        imageBase64: z.string().min(1).max(20_000_000),
        mimeType: z.string().max(100).optional(),
        prompt: z.string().max(2000).optional(),
      }),
      requiredPermission: "analyze",
      riskLevel: "LOW",
      reversible: true,
      auditRequired: false,
      run: async (ctx: ToolContext, input: { imageBase64: string; mimeType?: string; prompt?: string }) => {
        const key = env.DEEPSEEK_API_KEY ?? ctx.env.DEEPSEEK_API_KEY;
        if (!key) return { configured: false, note: "DEEPSEEK_API_KEY not configured." };
        const mime = input.mimeType ?? "image/png";
        const dataUrl = `data:${mime};base64,${input.imageBase64}`;
        const started = Date.now();
        const res = await fetch(API, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "deepseek-chat",
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: input.prompt ?? "Describe this image in detail. Note any UI issues (clipping, misalignment, scaling, color, missing assets) if it appears to be a plugin GUI." },
                  { type: "image_url", image_url: { url: dataUrl } },
                ],
              },
            ],
            max_tokens: 1024,
            stream: false,
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return { configured: true, error: `Vision provider ${res.status}: ${body.slice(0, 300)}`, note: "The provider may not support image inputs on this model/account." };
        }
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
        const latencyMs = Date.now() - started;
        const content = data.choices?.[0]?.message?.content ?? "";
        ctx.recordCost?.({
          provider: "deepseek",
          model: "deepseek-chat",
          taskType: "vision",
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
          cost: estimateCost(data.usage?.prompt_tokens ?? 0, data.usage?.completion_tokens ?? 0),
          latencyMs,
          timestamp: new Date().toISOString(),
        });
        return { configured: true, description: content.slice(0, 4000) };
      },
    },
  ];
}

/** Rough DeepSeek pricing (per 1M tokens) — used only for budgeting. */
function estimateCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * 0.27 + (outputTokens / 1_000_000) * 1.1;
}
