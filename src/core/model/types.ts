/**
 * Model call record — one LLM invocation's cost + latency + token usage.
 * Persisted to `model_costs` via the CostStorage interface so the Executive
 * can budget and audit every model dollar.
 *
 * The `providerCost` / `meterCost` / `usageReported` / `meterSource` fields are
 * the provenance of `cost` (migration v32, see db/meter-usage-schema.ts). They
 * are optional so an un-migrated or hand-built record still type-checks, but
 * `meterModelCall` always populates them — a stored call that cannot say where
 * its dollar figure came from is exactly the state that let recorded spend
 * diverge from actual provider usage unnoticed.
 */
export interface ModelCallRecord {
  provider: string;
  model: string;
  taskType: string;
  inputTokens: number;
  outputTokens: number;
  /** The value every dollar aggregate sums (provider figure when reported). */
  cost: number;
  /** The provider's own billed figure; undefined when it never reported usage. */
  providerCost?: number;
  /** What our price table yields for the same token counts. */
  meterCost?: number;
  /** True when a real provider `usage` block was consumed for this call. */
  usageReported?: boolean;
  /** How the token counts were obtained. */
  meterSource?: "provider_usage" | "char_fallback" | "missing_usage" | "legacy";
  sessionId?: string;
  runId?: string;
  latencyMs: number;
  timestamp: string;
}
