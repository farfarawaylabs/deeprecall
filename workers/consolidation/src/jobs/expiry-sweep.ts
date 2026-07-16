import type { DataService } from '@deeprecall/worker-data';

export interface ExpirySweepResult {
  expired_count: number;
  idempotency_cleaned: number;
}

/**
 * Expiry Sweep Job: clean up expired idempotency keys.
 *
 * This job used to also mark foresight memories past their validity_end as
 * expired and delete their vectors. That destroyed history: a plan whose
 * window has passed ("art show in September") is still real knowledge the
 * user can ask about later. Foresight freshness is enforced at query time —
 * the foresight/full_briefing injection paths only surface items with
 * validity_end in the future — so no stored record needs to be destroyed
 * for staleness.
 */
export async function runExpirySweep(
  data: Service<DataService>,
  productId: string,
): Promise<ExpirySweepResult> {
  const idempotencyCleaned = await data.idempotencyCleanup(productId);

  return {
    expired_count: 0,
    idempotency_cleaned: idempotencyCleaned,
  };
}
