import { createHmac, timingSafeEqual } from "node:crypto";

import { REPLY_TO } from "@/lib/email/shared";

/**
 * Receiving mail, and getting it to somewhere a human reads.
 *
 * Resend Inbound is enabled on the **root** domain, so every address
 * `@footvault.in` is accepted and delivered into the Resend dashboard. Nobody
 * reads a dashboard. Without this module a customer who replies to their order
 * confirmation is answered by nothing, and there is no bounce to tell them so —
 * see `REPLY_TO` in `shared.ts` for why that reply is set to a Gmail address in
 * the first place. This is the other half: the mail that arrives anyway,
 * because a customer typed `support@footvault.in`, or because a real person
 * looked at the domain and guessed.
 *
 * ## Everything here fails soft
 *
 * A forwarding failure must never throw, and must never make the route answer
 * non-2xx for a reason that will not improve on redelivery. The failure this
 * exists to prevent is the *loud* one — a mail nobody sees — and swapping it
 * for an endpoint Resend eventually disables would be the same outcome by a
 * longer road. Every function below returns a verdict.
 *
 * ## No `server-only`, on purpose
 *
 * Every function here takes its API key as an argument and reads no
 * environment, which makes this module pure in the same sense `lifecycle.ts`
 * is — and testable the same way, by `scripts/audit/inbound-email.ts`. The
 * signature check is the endpoint's entire authentication, so being able to
 * assert it against forged, tampered and replayed inputs matters more than an
 * import guard. The env reads live in the route, which is a server file
 * already.
 */

/* ------------------------------------------------------------ signature -- */

/** Five minutes, which is Svix's own tolerance. */
const TIMESTAMP_TOLERANCE_SECONDS = 300;

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string; retryable: boolean };

/**
 * Svix's scheme, by hand.
 *
 * Resend signs with Svix, and the `resend` SDK ships a `webhooks.verify`. Same
 * decision as `resend-adapter.ts` and for the same reason: this is thirty lines
 * of HMAC, and the alternative is a dependency in the server bundle sitting on
 * a public endpoint. `src/lib/payments/razorpay.ts` already verifies a webhook
 * by hand for Razorpay; a second provider doing it a second way would be the
 * odd one out.
 *
 * The three things that are easy to get wrong, all of which produce "every
 * signature fails and it looks like the secret is wrong":
 *
 *   1. The signed content is `id.timestamp.body`, over the **raw** body. A
 *      parsed-and-reserialised body has different whitespace and key order.
 *   2. The secret is base64 **after** stripping the `whsec_` prefix, and the
 *      HMAC key is those decoded bytes, not the string.
 *   3. `svix-signature` holds a space-separated list — a secret rotation puts
 *      two in flight at once — and each entry is `v1,<base64>`. Checking only
 *      the first breaks silently during a rotation.
 *
 * The timestamp check is what makes a captured request stop being replayable.
 * Its failure is *not* retryable: a redelivery of something already too old
 * arrives older still.
 */
export function verifyResendWebhook(
  rawBody: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  secret: string,
): VerifyResult {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature)
    return { ok: false, reason: "missing svix headers", retryable: false };

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt))
    return { ok: false, reason: "unparseable svix-timestamp", retryable: false };

  const drift = Math.abs(Date.now() / 1000 - sentAt);
  if (drift > TIMESTAMP_TOLERANCE_SECONDS)
    return {
      ok: false,
      reason: `timestamp ${Math.round(drift)}s outside tolerance`,
      retryable: false,
    };

  const base64Secret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let key: Buffer;
  try {
    key = Buffer.from(base64Secret, "base64");
  } catch {
    return { ok: false, reason: "signing secret is not base64", retryable: false };
  }
  if (key.length === 0)
    return { ok: false, reason: "signing secret is empty", retryable: false };

  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest();

  /*
    Constant-time compare against every offered signature. `timingSafeEqual`
    throws on a length mismatch, which is itself an oracle if it escapes, so the
    length is checked first and a mismatch is simply not a match.
  */
  const offered = signature.split(" ");
  for (const entry of offered) {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value) continue;
    const candidate = Buffer.from(value, "base64");
    if (candidate.length !== expected.length) continue;
    if (timingSafeEqual(candidate, expected)) return { ok: true };
  }

  return { ok: false, reason: "no signature matched", retryable: false };
}

/* -------------------------------------------------------------- fetching -- */

const API = "https://api.resend.com";
const TIMEOUT_MS = 10_000;

/**
 * Total attachment payload we are willing to carry into a forward.
 *
 * Resend's send limit is around 40MB and a function has its own memory ceiling;
 * base64 inflates by a third on top. Anything past this forwards as a body with
 * the attachments *named and not attached*, which is the honest outcome: the
 * owner learns a file exists and can open the original in the dashboard, rather
 * than the whole forward failing because someone sent a video.
 */
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

async function getJson<T>(path: string, apiKey: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(
        `[inbound] GET ${path} → HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`,
      );
      return null;
    }
    return (await response.json()) as T;
  } catch (error) {
    console.error(
      `[inbound] GET ${path} failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type ReceivedEmail = {
  from?: string;
  to?: string[];
  subject?: string;
  text?: string;
  html?: string;
};

export type ReceivedAttachment = {
  id: string;
  filename?: string;
  content_type?: string;
  size?: number;
  download_url?: string;
};

/**
 * The webhook carries metadata only — no body, no headers, no attachment
 * bytes — because a large attachment would not survive a serverless request
 * body limit. So the body is a second call, and it is the reason this route
 * cannot be a pure function of its payload.
 */
export function fetchReceivedEmail(
  emailId: string,
  apiKey: string,
): Promise<ReceivedEmail | null> {
  return getJson<ReceivedEmail>(`/emails/receiving/${emailId}`, apiKey);
}

export async function fetchAttachments(
  emailId: string,
  apiKey: string,
): Promise<ReceivedAttachment[]> {
  const body = await getJson<{ data?: ReceivedAttachment[] } | ReceivedAttachment[]>(
    `/emails/receiving/${emailId}/attachments`,
    apiKey,
  );
  if (!body) return [];
  return Array.isArray(body) ? body : (body.data ?? []);
}

/* ----------------------------------------------------------- forwarding -- */

export type ForwardResult = { ok: true } | { ok: false; reason: string };

/**
 * Send the message on, from us, replying to them.
 *
 * **`from` cannot be the customer.** It has to be an address on the verified
 * domain or the send is refused, and spoofing the sender would fail DMARC at
 * Gmail even if Resend allowed it. So the envelope is ours and `reply_to`
 * carries the customer — which is the arrangement that actually matters day to
 * day: hitting reply in Gmail answers the person who wrote in, not ourselves.
 *
 * The original recipient is preserved in the body rather than the envelope,
 * because `orders@` and `support@` arriving in the same inbox are otherwise
 * indistinguishable, and which address a customer guessed is worth knowing.
 */
export async function forwardEmail(args: {
  apiKey: string;
  from: string;
  to: string;
  received: ReceivedEmail;
  attachments: { filename: string; content: string }[];
  omittedAttachments: string[];
  receivedFor: string[];
}): Promise<ForwardResult> {
  const sender = args.received.from ?? "unknown sender";
  const subject = args.received.subject?.trim() || "(no subject)";
  const addressedTo = args.receivedFor.join(", ") || "unknown address";

  const preamble =
    `Forwarded from ${addressedTo}\n` +
    `From: ${sender}\n` +
    (args.omittedAttachments.length > 0
      ? `Attachments too large to forward: ${args.omittedAttachments.join(", ")} — open the original in Resend.\n`
      : "") +
    `\n---\n\n`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${API}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: args.from,
        to: [args.to],
        subject: `[footvault.in] ${subject}`,
        text: preamble + (args.received.text ?? "(no plain-text part)"),
        ...(args.received.html ? { html: args.received.html } : {}),
        /*
          The customer, so a reply in Gmail reaches them. Falls back to our own
          address rather than being omitted: a forward you cannot reply to is
          the problem this whole seam exists to solve.
        */
        reply_to: [isEmailish(sender) ? extractAddress(sender) : REPLY_TO],
        ...(args.attachments.length > 0
          ? { attachments: args.attachments }
          : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return {
        ok: false,
        reason: `HTTP ${response.status} ${detail.slice(0, 300)}`.trim(),
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error && error.name === "AbortError"
          ? `no response in ${TIMEOUT_MS}ms`
          : error instanceof Error
            ? error.message
            : "unknown",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** `"Priya Sharma <priya@example.com>"` → `"priya@example.com"`. */
export function extractAddress(value: string): string {
  const angled = /<([^>]+)>/.exec(value);
  return (angled?.[1] ?? value).trim();
}

function isEmailish(value: string): boolean {
  return /@/.test(value);
}

/**
 * Download what will fit, name what will not.
 *
 * Sequential rather than parallel on purpose: these are downloads of unknown
 * size on a function with a memory limit, and the running total is what decides
 * whether to take the next one. Fetching them all at once would mean deciding
 * after they are already in memory, which is the decision arriving too late to
 * be useful.
 */
export async function collectAttachments(
  attachments: ReceivedAttachment[],
): Promise<{
  taken: { filename: string; content: string }[];
  omitted: string[];
}> {
  const taken: { filename: string; content: string }[] = [];
  const omitted: string[] = [];
  let budget = MAX_ATTACHMENT_BYTES;

  for (const attachment of attachments) {
    const name = attachment.filename ?? `attachment-${attachment.id}`;
    if (!attachment.download_url) {
      omitted.push(name);
      continue;
    }
    if (typeof attachment.size === "number" && attachment.size > budget) {
      omitted.push(name);
      continue;
    }
    try {
      const response = await fetch(attachment.download_url);
      if (!response.ok) {
        omitted.push(name);
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > budget) {
        omitted.push(name);
        continue;
      }
      budget -= buffer.byteLength;
      taken.push({ filename: name, content: buffer.toString("base64") });
    } catch {
      omitted.push(name);
    }
  }

  return { taken, omitted };
}
