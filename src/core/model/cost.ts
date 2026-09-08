import type { ModelCallRecord } from "./types";

/**
 * CostStorage — anything that can persist a model call's cost record.
 * ExecutiveStore implements this against the `model_costs` table.
 */
export interface CostStorage {
  record(call: ModelCallRecord): void;
}
