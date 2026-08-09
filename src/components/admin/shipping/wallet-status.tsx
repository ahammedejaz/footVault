import { formatPaise } from "@/lib/format";
import type { WalletStatus } from "@/lib/shipping/wallet";

/**
 * The Shiprocket wallet, on the dashboard, next to the webhook heartbeat.
 *
 * An empty wallet stops shipping completely — no order created, no AWB, every
 * parcel in the shop waiting — and until now nothing in this application would
 * have said so. The owner would have found out by pressing "Create shipment" on
 * an order somebody had already paid for.
 *
 * So the balance is always rendered when it is known, not only when it is low.
 * Same argument as the webhook line above it: the useful thing about a
 * heartbeat is being able to see it beating, and a warning that has never once
 * appeared is a warning nobody trusts the first time it does.
 *
 * ## Three failure states, and they are not the same failure
 *
 *   **Could not read.** Never rendered as zero. "Unknown" means look again in a
 *   minute; zero means stop and recharge, and swapping them either sends the
 *   owner to top up an account that is fine or teaches them to ignore the line.
 *
 *   **No threshold configured.** Loud rather than silent. A missing threshold
 *   does not mean "never warn" — it means nothing is watching, which is the
 *   state most likely to be discovered by a stuck parcel. The number itself is
 *   the owner's to choose and is not invented here: what counts as low depends
 *   on how many parcels a day this shop sends and what they weigh.
 *
 *   **Low.** The one that is actually red.
 */
export function ShiprocketWalletStatus({ status }: { status: WalletStatus }) {
  const { reading, threshold, low } = status;

  if (reading.state === "unreadable") {
    return (
      <p
        role="status"
        className="border-orange/50 bg-orange/5 rounded-md border p-3 text-sm text-pretty"
      >
        <strong>The Shiprocket wallet balance could not be read.</strong> That
        is not the same as it being empty, and it is not the same as it being
        fine — it means we could not check. {reading.message} Shipping may be
        working normally; the only way to know right now is the Shiprocket
        panel.
      </p>
    );
  }

  const balance = formatPaise(reading.balancePaise);

  if (low && threshold.state === "set") {
    return (
      <p
        role="status"
        className="border-destructive/50 bg-destructive/5 rounded-md border p-3 text-sm text-pretty"
      >
        <strong>The Shiprocket wallet is down to {balance}.</strong> That is at
        or below the {formatPaise(threshold.paise)} you asked to be warned at.
        When it empties, shipping stops for every order at once — no shipment is
        created, no courier is assigned — so recharge it before the next parcel
        rather than after it.
      </p>
    );
  }

  if (threshold.state !== "set") {
    return (
      <p
        role="status"
        className="border-orange/50 bg-orange/5 rounded-md border p-3 text-sm text-pretty"
      >
        <strong>
          Nothing is watching the Shiprocket wallet. It holds {balance}.
        </strong>{" "}
        {threshold.state === "unset"
          ? "No low-balance warning level has been set, so this will not turn red before the wallet empties and shipping stops."
          : `The shipping settings could not be read, so the warning level is unknown: ${threshold.message}`}{" "}
        Set one at Settings → Delivery. It is your number to choose — it depends
        on how many parcels a day go out and what they weigh — so nothing here
        picks one for you.
      </p>
    );
  }

  return (
    <p role="status" className="text-muted-foreground text-sm">
      Shiprocket wallet: {balance}. Warning at {formatPaise(threshold.paise)}.
    </p>
  );
}
