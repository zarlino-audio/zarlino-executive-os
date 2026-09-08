/**
 * Financial assessment helpers (spec §Finance). Pure arithmetic — no side
 * effects, safe to call from anywhere. Unknown inputs are reported explicitly
 * rather than guessed (doctrine: HONEST_NUMBERS).
 */

export interface FinancialInputs {
  cash?: number;
  monthlyRevenue?: number;
  monthlyExpenses?: number;
}

export interface FinancialAssessment {
  runwayMonths: number | null;
  netBurn: number | null;
  grossMargin: number | null;
  unknown: string[];
}

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

export function assessFinancials(input: FinancialInputs): FinancialAssessment {
  const unknown: string[] = [];
  const cash = finite(input.cash) ? input.cash : (unknown.push("cash"), undefined);
  const revenue = finite(input.monthlyRevenue)
    ? input.monthlyRevenue
    : (unknown.push("monthlyRevenue"), undefined);
  const expenses = finite(input.monthlyExpenses)
    ? input.monthlyExpenses
    : (unknown.push("monthlyExpenses"), undefined);

  const netBurn = revenue !== undefined && expenses !== undefined ? expenses - revenue : null;
  const runwayMonths =
    cash !== undefined && netBurn !== null && netBurn > 0 ? cash / netBurn : null;
  const grossMargin =
    revenue !== undefined && revenue > 0 && expenses !== undefined
      ? ((revenue - expenses) / revenue) * 100
      : null;

  return { runwayMonths, netBurn, grossMargin, unknown };
}
