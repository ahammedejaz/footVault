import { NextResponse } from "next/server";

import {
  collectAttachments,
  fetchAttachments,
  fetchReceivedEmail,
  forwardEmail,
  verifyResendWebhook,
} from "@/lib/email/inbound";
import { REPLY_TO } from "@/lib/email/shared";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Resend's inbound webhook. Mail addressed to footvault.in, on its way to a
 * mailbox somebody reads.
 *
 * Receiving is enabled on the **root** domain, so anything `@footvault.in` is
 * accepted and lands in the Resend dashboard. This endpoint is what moves it
 * out of there. Same three facts shape it as the Razorpay webhook next door,
 * and the arrangement is deliberately the same so that one file explains both:
 *
 *   **It is public.** The Svix signature is the entire authentication, checked
 *   before anything else, and a missing `RESEND_WEBHOOK_SECRET` rejects every
 *   request rather than accepting unverified ones. An open forwarder is worse
 *   than a broken one: it would relay anything anyone posted, from our verified
 *   domain, into the owner's inbox.
 *
 *   **It is retried.** Non-2xx is redelivered, so the handler is idempotent —
 *   `inbound_emails.email_id` is claimed before a forward is attempted. Keyed
 *   on the message rather than the delivery, for the reason written into
 *   `20260810060000_inbound_emails.sql`.
 *
 *   **The payload is metadata only.** No body, no attachment bytes. Both are a
 *   second and third call to the Received emails API, which is why this route
 *   is not a pure function of what it was posted.
 *
 * ## What "fail soft" means here, precisely
 *
 * A forwarding failure never throws and never 500s. Once the claim is written
 * the message is *ours*: answering 500 would earn a redelivery that the claim
 * then dedupes into a no-op, so the retry cannot help and the only thing it
 * achieves is pushing the endpoint towards being disabled. The failure is
 * recorded in `forward_error` with `forwarded_at` still null — the row a human
 * looks for when a customer says nobody answered — and the response is 200.
 *
 * The one exception is a failure *before* the claim, where a retry genuinely
 * can help: that answers 500 on purpose.
 */

/** `node:crypto` for the HMAC. Not available on the edge runtime. */
export const runtime = "nodejs";

/** Never cacheable, never prerendered. */
export const dynamic = "force-dynamic";

/**
 * Resend's inbound payloads carry metadata only, so they are small. A megabyte
 * is not one, and HMACing it before finding that out is doing an attacker's
 * memory allocation for them — the same guard, and the same number, as the
 * Razorpay route.
 */
const MAX_BODY_BYTES = 1_000_000;

type InboundPayload = {
  type?: string;
  data?: {
    email_id?: string;
    from?: string;
    to?: string[];
    received_for?: string[];
    subject?: string;
  };
};

export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  const apiKey = process.env.EMAIL_API_KEY?.trim();

  if (!secret) {
    // Not configured is not "allow". Until the secret exists nothing here can
    // be authenticated, so nothing is accepted.
    console.error("[inbound] RESEND_WEBHOOK_SECRET is not set — refusing");
    return json(401, { ok: false });
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    console.warn("[inbound] rejected: body too large", { declaredLength });
    return json(400, { ok: false });
  }

  /*
    The raw bytes. `request.json()` would break the signature outright: the
    HMAC is over exactly what Svix signed, and re-serialising a parsed object
    changes whitespace and key order.
  */
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    console.warn("[inbound] rejected: body could not be read");
    return json(400, { ok: false });
  }

  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    console.warn("[inbound] rejected: body too large");
    return json(400, { ok: false });
  }

  const svixId = request.headers.get("svix-id");
  const verified = verifyResendWebhook(
    rawBody,
    {
      id: svixId,
      timestamp: request.headers.get("svix-timestamp"),
      signature: request.headers.get("svix-signature"),
    },
    secret,
  );

  if (!verified.ok) {
    // The payload is never logged, by us or by the adapter. The reason is.
    console.warn("[inbound] rejected", { svixId, reason: verified.reason });
    return json(401, { ok: false });
  }

  let payload: InboundPayload;
  try {
    payload = JSON.parse(rawBody) as InboundPayload;
  } catch {
    console.warn("[inbound] verified but unparseable", { svixId });
    return json(400, { ok: false });
  }

  if (payload.type !== "email.received") {
    // Resend sends whatever the endpoint is subscribed to. An event we do not
    // handle is not a failure — 400ing on it would put the endpoint into retry
    // and then into disabled, taking the events we *do* handle with it.
    console.info("[inbound] ignored", { svixId, type: payload.type });
    return json(200, { ok: true, ignored: true });
  }

  const emailId = payload.data?.email_id;
  if (!emailId) {
    console.warn("[inbound] email.received with no email_id", { svixId });
    return json(200, { ok: true, ignored: true });
  }

  if (!apiKey) {
    /*
      Verified, and we cannot fetch the body without a key. This is the one
      failure a redelivery can genuinely fix — the key is one deploy away — so
      it is the one that answers 500 and asks to be sent again. Nothing is
      claimed, deliberately: claiming here would dedupe away the retry that
      would have worked.
    */
    console.error("[inbound] EMAIL_API_KEY is not set — cannot fetch the body");
    return json(500, { ok: false });
  }

  const admin = createAdminClient();

  /*
    Claim before forwarding, never after. A duplicate delivery loses the insert
    on the primary key and returns here, so the customer's mail cannot be
    forwarded twice — which is the whole reason the table exists.
  */
  const { error: claimError } = await admin.from("inbound_emails").insert({
    email_id: emailId,
    svix_id: svixId,
    from_address: payload.data?.from ?? null,
    to_addresses: payload.data?.received_for ?? payload.data?.to ?? null,
    subject: payload.data?.subject ?? null,
  });

  if (claimError) {
    if (claimError.code === "23505") {
      console.info("[inbound] already handled", { svixId, emailId });
      return json(200, { ok: true, duplicate: true });
    }
    // The claim itself failed. Nothing has been forwarded and a retry may work.
    console.error("[inbound] could not claim", {
      svixId,
      emailId,
      code: claimError.code,
      detail: claimError.message,
    });
    return json(500, { ok: false });
  }

  /*
    From here on the message is ours and every path answers 200. Failures are
    written to the row rather than to the status code — see the header.
  */
  try {
    const received = await fetchReceivedEmail(emailId, apiKey);
    if (!received) {
      await recordFailure(admin, emailId, "could not fetch the message body");
      return json(200, { ok: true, forwarded: false });
    }

    const attachments = await fetchAttachments(emailId, apiKey);
    const { taken, omitted } = await collectAttachments(attachments);

    const from = process.env.EMAIL_FROM?.trim();
    if (!from) {
      await recordFailure(admin, emailId, "EMAIL_FROM is not set");
      return json(200, { ok: true, forwarded: false });
    }

    const result = await forwardEmail({
      apiKey,
      from,
      to: forwardingDestination(),
      received,
      attachments: taken,
      omittedAttachments: omitted,
      receivedFor: payload.data?.received_for ?? payload.data?.to ?? [],
    });

    if (!result.ok) {
      console.error("[inbound] forward refused", { emailId, reason: result.reason });
      await recordFailure(admin, emailId, result.reason);
      return json(200, { ok: true, forwarded: false });
    }

    /*
      The forward has already happened, so this failing does not undo it — it
      leaves a delivered message sitting in the "never forwarded" queue, which
      sends a human looking for a problem that does not exist. Logged rather
      than retried: re-sending the mail to fix a bookkeeping row would be the
      cure being worse than the disease.
    */
    const { error: markError } = await admin
      .from("inbound_emails")
      .update({ forwarded_at: new Date().toISOString(), forward_error: null })
      .eq("email_id", emailId);
    if (markError)
      console.error("[inbound] forwarded but could not mark the row", {
        emailId,
        detail: markError.message,
      });

    console.info("[inbound] forwarded", {
      emailId,
      attachments: taken.length,
      omitted: omitted.length,
    });
    return json(200, { ok: true, forwarded: true });
  } catch (error) {
    /*
      The catch that makes "fail soft" true rather than intended. Anything
      unforeseen between here and the claim lands as a recorded failure and a
      200, because the alternative is a redelivery this route will dedupe into
      nothing while Resend counts it as an outage.
    */
    const reason = error instanceof Error ? error.message : "unknown";
    console.error("[inbound] threw while forwarding", { emailId, reason });
    await recordFailure(admin, emailId, reason).catch(() => {});
    return json(200, { ok: true, forwarded: false });
  }
}

/** Never throws: it is called from the path that must not fail. */
async function recordFailure(
  admin: ReturnType<typeof createAdminClient>,
  emailId: string,
  reason: string,
): Promise<void> {
  const { error } = await admin
    .from("inbound_emails")
    .update({ forward_error: reason.slice(0, 500) })
    .eq("email_id", emailId);
  if (error)
    console.error("[inbound] could not record the failure", {
      emailId,
      detail: error.message,
    });
}

/**
 * Where forwarded mail goes.
 *
 * Falls back to `REPLY_TO` rather than to nothing. `OWNER_EMAIL` is optional
 * everywhere else in this codebase — an unset value *skips* the owner's
 * new-order copy — but skipping is the wrong behaviour here: the message has
 * already been accepted and there is nowhere else for it to go. The constant is
 * the same mailbox a customer is told to reply to, which is the address that
 * has to work whatever else is unset.
 */
function forwardingDestination(): string {
  return process.env.OWNER_EMAIL?.trim() || REPLY_TO;
}

function json(status: number, body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
