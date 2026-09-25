// Spend ledger helpers: public.budget_status() / public.record_usage() (see migration 20260925000001_cities.sql).
import { db } from "./db.ts";

export type BudgetStatus = {
  cap_usd: number;
  spent_usd: number;
  remaining_usd: number;
  by_sku: Record<string, { units: number; usd: number }>;
};

/** This month's (America/Chicago) cap / spend / remaining. Throws if the RPC fails. */
export async function budgetStatus(): Promise<BudgetStatus> {
  const { data, error } = await db().rpc("budget_status");
  if (error) throw new Error(`budget_status: ${error.message}`);
  const b = (data ?? {}) as Record<string, unknown>;
  return {
    cap_usd: Number(b.cap_usd ?? 0),
    spent_usd: Number(b.spent_usd ?? 0),
    remaining_usd: Number(b.remaining_usd ?? 0),
    by_sku: (b.by_sku ?? {}) as BudgetStatus["by_sku"],
  };
}

/**
 * Record usage for one SKU. With usd omitted the database prices it from app_settings.sku_prices,
 * charging only the part above the monthly free allowance. Returns the recorded est. USD (0 on failure).
 */
export async function recordUsage(u: {
  service: string; sku: string; units: number; usd?: number | null; cityId?: string | null; job?: string | null;
}): Promise<number> {
  if (!(u.units > 0) && !u.usd) return 0;
  const { data, error } = await db().rpc("record_usage", {
    p_service: u.service, p_sku: u.sku, p_units: u.units, p_usd: u.usd ?? null,
    p_city_id: u.cityId ?? null, p_job: u.job ?? null,
  });
  if (error) { console.error("record_usage", u.sku, error.message); return 0; }
  return Number(data ?? 0);
}

/** Accumulates units per SKU during a run so they can be written in one batch at the end. */
export class UsageTally {
  private units = new Map<string, number>();
  constructor(private service: string, private job: string, private cityId: string | null = null) {}
  add(sku: string, n = 1) { this.units.set(sku, (this.units.get(sku) ?? 0) + n); }
  get(sku: string) { return this.units.get(sku) ?? 0; }
  /** Writes one api_usage row per SKU with units > 0, resets the tally, returns total est. USD. */
  async flush(): Promise<number> {
    let usd = 0;
    const entries = [...this.units.entries()];
    this.units.clear();
    for (const [sku, units] of entries) {
      if (units > 0) usd += await recordUsage({ service: this.service, sku, units, cityId: this.cityId, job: this.job });
    }
    return usd;
  }
}
