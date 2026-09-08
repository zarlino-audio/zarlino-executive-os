/**
 * Model call record — one LLM invocation's cost + latency + token usage.
 * Persisted to `model_costs` via the CostStorage interface so the Executive
 * can budget and audit every model dollar.
 */
export interface ModelCallRecord {
  provider: string;
  model: string;
  taskType: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  sessionId?: string;
  runId?: string;
  latencyMs: number;
  timestamp: string;
}
