/**
 * Why a replacement was granted.
 *
 * In its own module rather than beside the action that uses it, because a
 * `"use server"` file may only export async functions — a plain constant
 * exported from one is a build error, and the failure message points at the
 * import rather than at the export. The admin form needs these labels in the
 * browser, so they live somewhere a Client Component can reach.
 *
 * The shop's policy covers exactly one of these — damage in transit — but the
 * other two exist because they happen and the owner needs somewhere honest to
 * put them. A shop that sends the wrong shoe has made its own mistake, and
 * filing that under "damaged in transit" would hide the one category of failure
 * worth counting.
 */
export const REPLACEMENT_REASONS = [
  "damaged_in_transit",
  "wrong_item_sent",
  "other",
] as const;

export type ReplacementReason = (typeof REPLACEMENT_REASONS)[number];

export const REPLACEMENT_REASON_LABEL: Record<ReplacementReason, string> = {
  damaged_in_transit: "Damaged in transit",
  wrong_item_sent: "We sent the wrong item",
  other: "Other",
};
