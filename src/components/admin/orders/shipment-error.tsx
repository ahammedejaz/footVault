import Link from "next/link";
import { ExternalLink } from "lucide-react";

/**
 * Why the last fulfilment step failed, and what to do about it.
 *
 * Before this, a Shiprocket refusal lived in a toast for three and a half
 * seconds and then stopped existing. The owner pressed "Create shipment", saw a
 * red line they had no time to read, reloaded, and the panel showed a button
 * that looked exactly as it had before. Nothing on the page said the parcel was
 * stuck, let alone why.
 *
 * ## Shiprocket's sentence is printed verbatim, always
 *
 * Every branch below renders `message` exactly as it was received, and the
 * advice is *added* beside it rather than substituted for it. Two reasons, and
 * the second is the one that decided the design:
 *
 *   1. Their wording is usually better than ours. "Wrong Pickup location
 *      entered" names the field to fix. Any paraphrase loses that.
 *   2. **An unrecognised message must still be readable.** A mapper that only
 *      printed its own copy would answer a message it had never seen with
 *      "something went wrong" — which is precisely the failure this whole item
 *      exists to remove, reintroduced one layer up. So the mapping can only
 *      ever add an action; it can never swallow a message.
 *
 * ## Why the links point at the panel rather than deep into it
 *
 * Shiprocket's in-app routes are undocumented and not stable, and their support
 * pages describe every one of these tasks as a menu path ("click Recharge
 * Wallet in the top bar") rather than a URL. A deep link that 404s while the
 * shop's parcels are stuck is worse than one extra click, so each link goes to
 * the panel and the label carries the menu path. Where the fix is ours rather
 * than theirs — an unset parcel dimension, a product with no weight — the link
 * goes to the admin page that owns the field instead.
 */

export type ShipmentFailure = {
  /** Which of the five steps: create, awb, pickup, documents, track. */
  step: string;
  /** Shiprocket's own words. Rendered as-is. */
  message: string;
  failedAt: string | null;
};

export type ShipmentErrorAdvice = {
  /**
   * What the message means, when we recognise it. Null is a legitimate answer
   * and renders nothing — better silent than confidently wrong about somebody
   * else's error.
   */
  cause: string | null;
  /** What to do next. Never null: an error with no next step is a dead end. */
  action: string;
  link: { href: string; label: string; external: boolean } | null;
};

/** The Shiprocket panel. Deep routes are deliberately not used — see the header. */
const SHIPROCKET_PANEL = "https://app.shiprocket.in/";

const STEP_LABEL: Record<string, string> = {
  create: "Creating the shipment",
  awb: "Assigning a courier",
  pickup: "Booking the pickup",
  documents: "Printing the documents",
  track: "Fetching tracking",
};

/**
 * Shiprocket's message → what the owner should do.
 *
 * Matched on substrings of the lowercased message rather than on a status code,
 * because Shiprocket returns the same 400 for all of these and puts the
 * distinguishing information in prose. The order of the tests matters: our own
 * parcel-defaults error mentions dimensions too, and it has a different fix.
 */
export function shipmentErrorAdvice(message: string): ShipmentErrorAdvice {
  const text = message.toLowerCase();

  /**
   * Ours, not theirs. `shippingDefaults()` throws when the shop's default box
   * is incomplete, and right now `default_parcel_height_cm` is unset — so this
   * is the failure a real press of "Create shipment" produces today. The fix is
   * one field on our own settings page, and saying "contact Shiprocket" would
   * send the owner to entirely the wrong building.
   */
  if (text.includes("default_parcel_") || text.includes("parcel defaults")) {
    return {
      cause:
        "The shop's default parcel is missing a measurement, so nothing was sent to Shiprocket.",
      action:
        "Fill in the missing field on the settings page. Shiprocket prices on whichever of weight and volume is greater and will not accept a parcel with a dimension missing, so no value is assumed for you — a guessed box would misprice every parcel invisibly.",
      link: {
        href: "/admin/settings",
        label: "Settings → Delivery",
        external: false,
      },
    };
  }

  if (
    text.includes("insufficient") ||
    text.includes("wallet") ||
    text.includes("recharge") ||
    text.includes("low balance")
  ) {
    return {
      cause:
        "The Shiprocket wallet does not have enough in it to pay for this parcel.",
      action:
        "Recharge the wallet, then press the step again. Nothing ships while it is empty — this is not specific to this order, every parcel in the shop is waiting on it.",
      link: {
        href: SHIPROCKET_PANEL,
        label: "Shiprocket panel → Recharge Wallet",
        external: true,
      },
    };
  }

  if (text.includes("pickup location") || text.includes("pickup address")) {
    return {
      cause:
        "Shiprocket does not recognise the pickup location this shop sends it.",
      action:
        "SHIPROCKET_PICKUP_LOCATION must match the nickname in Settings → Company → Pickup Addresses exactly, character for character — Shiprocket matches it as a literal string. Changing it is a deployment change, not a settings change.",
      link: {
        href: SHIPROCKET_PANEL,
        label: "Shiprocket panel → Settings → Company → Pickup Addresses",
        external: true,
      },
    };
  }

  const unserviceable =
    text.includes("not serviceable") ||
    text.includes("unserviceable") ||
    text.includes("no courier") ||
    text.includes("not available");

  if (unserviceable && (text.includes("cod") || text.includes("cash"))) {
    return {
      cause: "No courier will collect cash at this PIN code.",
      action:
        "This parcel cannot go out as Pay on Delivery. Ask the customer to pay the balance online and ship it prepaid, or cancel and refund the advance — do not create it and hope, because the courier will refuse it at the door.",
      link: {
        href: SHIPROCKET_PANEL,
        label: "Shiprocket panel → check the PIN code",
        external: true,
      },
    };
  }

  if (unserviceable) {
    return {
      cause: "No courier on this account serves that address.",
      action:
        "Check the PIN code on the order is right. If it is, this address cannot be served by the couriers enabled on the account, and the customer has to be told rather than left waiting.",
      link: {
        href: SHIPROCKET_PANEL,
        label: "Shiprocket panel → check the PIN code",
        external: true,
      },
    };
  }

  if (
    text.includes("weight") ||
    text.includes("dimension") ||
    text.includes("volumetric") ||
    text.includes("length") ||
    text.includes("breadth")
  ) {
    return {
      cause: "Shiprocket would not accept the parcel's weight or box size.",
      action:
        "Set the weight and box size on the product itself, or the shop's default box on the settings page if this is an ordinary parcel. A product with no weight of its own ships at the default.",
      link: {
        href: "/admin/settings",
        label: "Settings → Delivery",
        external: false,
      },
    };
  }

  if (
    text.includes("unauthor") ||
    text.includes("token") ||
    text.includes("credential") ||
    text.includes("api user")
  ) {
    return {
      cause: "Shiprocket would not accept our sign-in.",
      action:
        "Check the API user still exists under Settings → API → Configure and that its password has not been changed. Its email has to be different from the account's own login email.",
      link: {
        href: SHIPROCKET_PANEL,
        label: "Shiprocket panel → Settings → API → Configure",
        external: true,
      },
    };
  }

  /**
   * Not recognised, and said so rather than guessed at. The message above is
   * still printed in full, which is the whole point: an error we have never
   * seen is exactly the one worth reading word for word.
   */
  return {
    cause: null,
    action:
      "Shiprocket refused the step and the line above is its own wording. Find this order in the Shiprocket panel, fix what it names, then press the step again — every step here is safe to press twice.",
    link: {
      href: SHIPROCKET_PANEL,
      label: "Shiprocket panel",
      external: true,
    },
  };
}

export function ShipmentErrorNotice({
  failure,
}: {
  failure: ShipmentFailure | null;
}) {
  if (!failure) return null;

  const advice = shipmentErrorAdvice(failure.message);
  const step = STEP_LABEL[failure.step] ?? "The last step";

  return (
    <div
      role="status"
      className="border-destructive/50 bg-destructive/5 rounded-md border p-3 text-sm text-pretty"
    >
      <p className="font-medium">
        {step} failed
        {failure.failedAt
          ? ` ${new Date(failure.failedAt).toLocaleString()}`
          : ""}
        .
      </p>

      {/*
        Verbatim, in mono, and never truncated. `break-words` because Shiprocket
        sometimes answers with an unbroken string longer than this column.
      */}
      <p className="border-border bg-background mt-2 rounded-sm border p-2 font-mono text-xs break-words">
        &ldquo;{failure.message}&rdquo;
      </p>

      {advice.cause ? <p className="mt-2">{advice.cause}</p> : null}
      <p className="mt-1">{advice.action}</p>

      {advice.link ? (
        <p className="mt-2">
          {advice.link.external ? (
            <a
              href={advice.link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="hit-44 inline-flex items-center gap-1 underline underline-offset-2"
            >
              {advice.link.label}
              <ExternalLink aria-hidden className="size-3" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          ) : (
            <Link
              href={advice.link.href}
              className="hit-44 inline-flex items-center gap-1 underline underline-offset-2"
            >
              {advice.link.label}
            </Link>
          )}
        </p>
      ) : null}
    </div>
  );
}
