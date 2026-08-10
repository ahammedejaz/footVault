import type { CourierQuote } from "./serviceability";

/**
 * Which courier actually carries the parcel, and on whose judgement.
 *
 * ## Why this exists
 *
 * `assignAwb` used to post `{ shipment_id }` and nothing else, which lets
 * Shiprocket choose. On both lanes tested during Phase 10, **Shiprocket's
 * recommended courier scored worst of the available set on all three of
 * `SLA_Adherence`, `rto_performance` and `tracking_performance`.** The
 * recommendation optimises for something, and whatever that something is, it is
 * not the shop's return rate.
 *
 * The scores were already being parsed into `CourierQuote` and were already
 * being thrown away. This is the part that reads them.
 *
 * ## The three modes
 *
 * `cheapest` — lowest quoted rate. Defensible, and what most shops do.
 *
 * `shiprocket` — whatever the recommendation says. The previous behaviour,
 * kept as an explicit choice rather than as an accident, so that picking it is
 * a decision somebody made.
 *
 * `best_rated` — the best-scoring courier **within a price tolerance of the
 * cheapest**. This is the one the evidence points at, and it is the one that
 * needs a number: how much more the shop will pay for a courier that actually
 * delivers. That number is the owner's, and it is deliberately not defaulted —
 * see below.
 *
 * ## Built unset, failing loudly
 *
 * `best_rated` with no tolerance does not quietly become "cheapest", and does
 * not quietly become "any price". Both are decisions about the shop's money
 * that nobody made. It returns a refusal naming the missing setting, and the
 * caller falls back to letting Shiprocket choose — the previous behaviour —
 * while logging that it did. A shop that silently spends more because a form
 * field was blank is the failure this rule exists to prevent.
 */

export const COURIER_SELECTION_MODES = [
  "cheapest",
  "shiprocket",
  "best_rated",
] as const;

export type CourierSelectionMode = (typeof COURIER_SELECTION_MODES)[number];

export type CourierChoice =
  | {
      ok: true;
      courier: CourierQuote;
      mode: CourierSelectionMode;
      /** One line for the admin and for the shipment row. */
      reason: string;
    }
  | {
      ok: false;
      /** `unset` is a missing owner decision; `no_couriers` is an empty lane. */
      reason: "unset" | "no_couriers";
      message: string;
    };

/**
 * The three scores as one number, 0–100.
 *
 * A mean rather than a weighted blend, because a weighting is a claim about
 * which failure costs the shop most and no evidence has been gathered for that
 * yet. Missing scores are skipped rather than treated as zero: Shiprocket omits
 * them for newer couriers, and scoring an unknown as terrible would exclude a
 * courier for the crime of being new.
 *
 * A courier with no scores at all returns null and is ranked last, because
 * "best rated" cannot honestly mean "unrated".
 */
export function courierScore(courier: CourierQuote): number | null {
  const parts = [
    courier.slaAdherence,
    courier.rtoPerformance,
    courier.trackingPerformance,
  ].filter((value): value is number => typeof value === "number");

  if (parts.length === 0) return null;
  return parts.reduce((total, value) => total + value, 0) / parts.length;
}

/**
 * Pick one.
 *
 * `tolerancePercent` is how far above the cheapest rate `best_rated` may go —
 * 10 means "up to 10% more". Null means the owner has not set it.
 */
export function chooseCourier(input: {
  couriers: CourierQuote[];
  mode: CourierSelectionMode;
  tolerancePercent: number | null;
  recommendedCourierId: number | null;
}): CourierChoice {
  const usable = input.couriers.filter(
    (courier) => !courier.excluded && courier.ratePaise !== null,
  );

  if (usable.length === 0) {
    return {
      ok: false,
      reason: "no_couriers",
      message: "No courier on this lane quoted a rate.",
    };
  }

  const byPrice = [...usable].sort(
    (a, b) => (a.ratePaise ?? 0) - (b.ratePaise ?? 0),
  );
  const cheapest = byPrice[0]!;

  if (input.mode === "cheapest") {
    return {
      ok: true,
      courier: cheapest,
      mode: "cheapest",
      reason: `Cheapest of ${usable.length}`,
    };
  }

  if (input.mode === "shiprocket") {
    const recommended =
      usable.find((courier) => courier.id === input.recommendedCourierId) ??
      cheapest;
    return {
      ok: true,
      courier: recommended,
      mode: "shiprocket",
      reason:
        recommended.id === input.recommendedCourierId
          ? "Shiprocket's recommendation"
          : "Shiprocket recommended nothing usable; fell back to cheapest",
    };
  }

  if (input.tolerancePercent === null) {
    return {
      ok: false,
      reason: "unset",
      message:
        "Courier selection is set to best-rated, but the price tolerance has " +
        "not been set. Set it at /admin/settings — it decides how much more " +
        "the shop will pay for a courier that delivers reliably.",
    };
  }

  const ceiling =
    (cheapest.ratePaise ?? 0) * (1 + input.tolerancePercent / 100);
  const affordable = usable.filter(
    (courier) => (courier.ratePaise ?? Infinity) <= ceiling,
  );

  /**
   * Ranked by score, then by price as the tie-break — so two couriers rated the
   * same do not get picked by array order, which is whatever Shiprocket
   * happened to return.
   */
  const ranked = [...affordable].sort((a, b) => {
    const scoreA = courierScore(a);
    const scoreB = courierScore(b);
    if (scoreA === null && scoreB === null) {
      return (a.ratePaise ?? 0) - (b.ratePaise ?? 0);
    }
    if (scoreA === null) return 1;
    if (scoreB === null) return -1;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return (a.ratePaise ?? 0) - (b.ratePaise ?? 0);
  });

  const best = ranked[0] ?? cheapest;
  const score = courierScore(best);

  return {
    ok: true,
    courier: best,
    mode: "best_rated",
    reason:
      score === null
        ? `No courier within ${input.tolerancePercent}% is rated; took the cheapest`
        : `Best rated (${score.toFixed(0)}) within ${input.tolerancePercent}% of the cheapest`,
  };
}
