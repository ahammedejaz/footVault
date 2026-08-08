# Foot Vault — the owner's guide

Written for the person who runs the shop, not for a developer. Nothing here
needs a code editor.

Where a step has to happen in the Supabase dashboard, it says so and gives you
the exact thing to paste.

---

## Making yourself an admin

You need this once. Until you do it, `/admin` will show "page not found" for
you, exactly as it does for a customer — that is deliberate, so nobody can
discover the admin area exists by guessing at web addresses.

**Step 1 — sign in to the shop first.**
Go to the storefront and sign in with Google, using the address you want to be
the admin account. This has to happen before step 2, because you are promoting
an account that must already exist.

**Step 2 — run one line in Supabase.**

1. Open <https://supabase.com/dashboard> and choose the Foot Vault project.
2. In the left sidebar, click **SQL Editor**.
3. Click **New query**.
4. Paste this, replacing the address with your own:

```sql
select private.promote_to_admin('you@example.com');
```

5. Click **Run**.

You will get one of two answers:

| What it says | What it means |
|---|---|
| `you@example.com is now an admin.` | Done. |
| `No account found for you@example.com. Sign in with Google once first, then run this again.` | Step 1 has not happened yet, or the address is spelled differently from the one Google gave us. |

**Step 3 — check it worked.**
Go back to the shop and open `/admin`. You should see the admin page rather
than "page not found". If you still get "page not found", sign out and back in:
your browser is holding a session from before the change.

### Why it is not a button

Anything that can grant admin rights over the web is something an attacker can
try to reach over the web. This function deliberately lives outside the part of
the database the website can talk to, so the only way to run it is to already
be signed in to the Supabase dashboard as the account owner — which is you, and
which no customer can be.

### Making somebody else an admin, or removing one

The same command promotes anyone. To take admin rights away again, or to make
somebody a staff member rather than a full admin:

```sql
-- back to an ordinary customer
update public.profiles set role = 'customer'
where id = (select id from auth.users where lower(email) = lower('them@example.com'));

-- staff: can see the admin area, same as an admin for now
update public.profiles set role = 'staff'
where id = (select id from auth.users where lower(email) = lower('them@example.com'));
```

---

## Signing in

Customers sign in with Google and nothing else. There is no password to forget,
no reset email to wait for, and no registration form to fill in.

**Customers never need an account to buy.** Signing in is what makes a bag
survive moving to a new phone, keeps a saved list, and puts past orders in one
place. Checkout stays open to guests, deliberately.

---

## The announcement bar

The thin strip above the header. Its text lives in the database, under
**Table editor → site_settings → announcement**, so you can change it without
anyone deploying code.

The value looks like this:

```json
{ "text": "Free returns within 7 days", "href": "/page/returns", "is_active": true }
```

- `text` — what it says. Keep it short; it is one line on a phone.
- `href` — where it goes when tapped. Leave it out for a strip that is not a link.
- `is_active` — set to `false` to remove the strip entirely.

**When you change the text, everyone sees the new one — including people who
dismissed the old one.** That is on purpose: closing "Free returns within 7
days" should not also hide next month's sale. The dismissal remembers *which*
message was closed, not that any message was.

---

## Free shipping and the delivery charge

Under **Table editor → site_settings → shipping**:

```json
{ "flat_fee_paise": 9900, "free_above_paise": 199900, "currency": "INR", "regions": ["IN"] }
```

Amounts are in **paise**, not rupees — ₹99 is `9900`, ₹1,999 is `199900`. The
whole storefront reads these two numbers: the bag's "₹560 away from free
shipping" bar, the delivery line at checkout, and the promise strip on the
homepage all follow whatever you put here. Checkout does not read a number the
customer's browser sent — it recomputes the total from your catalog and these
settings at the moment the order is written.

---

## Orders

Customers can now buy. What you can do with the result today is limited, and it
is worth being precise about where the limits are.

### Where orders live

There is **no admin screen for orders yet.** That is Phases 6 and 7. Until then
there are two places to look:

1. **Supabase → Table editor → `orders`.** Every order, newest by `placed_at`.
   The lines are in `order_items`, and `order_status_history` is the timeline of
   everything that has happened to it.
2. **The shop itself.** A signed-in customer sees their own orders at
   `/account/orders`; you see yours the same way. You cannot see somebody else's
   through the storefront, even as an admin — the pages read through the same
   Row Level Security everyone else does.

### What the statuses mean

| Status | Means |
|---|---|
| `pending` | The order exists and its stock is already reserved, but the money has not arrived. A card payment sits here until the bank confirms |
| `confirmed` | Money settled, **or** it is a cash-on-delivery order, which is confirmed the moment it is placed because there is nothing to wait for |
| `packed` | You have picked and boxed it |
| `shipped` | It is with the courier |
| `delivered` | It arrived |
| `cancelled` | It will not happen. **Cancelling puts the shoes back in stock automatically** |
| `returned` | It came back |

An order can only move forward, and only along the arrows in
`docs/architecture.md`. `cancelled` and `returned` are final: an order that has
to come back from either is a new order, not an edited one.

**`returned` deliberately does not put the shoes back in stock.** A returned pair
has to be looked at before it can be sold again, and putting it back
automatically would sell a damaged shoe to the next customer. Adjust the count
by hand in `product_variants` when you have inspected it.

### Changing a status by hand

Until the admin panel exists, this is a `SQL Editor` job. To mark an order
packed:

```sql
update public.orders set status = 'packed'
 where order_number = 'FV-2026-00042';

insert into public.order_status_history (order_id, status, note)
select id, 'packed', 'Picked and boxed' from public.orders
 where order_number = 'FV-2026-00042';
```

The second statement is not optional if you want the customer to see it — the
timeline on their order page is that table, and a status change without a
history row is a status that appears to have happened by itself.

**To cancel, do not do it by hand.** Use the function, because it is the only
thing that returns the stock exactly once:

```sql
select public.cancel_order_with_restock(
  (select id from public.orders where order_number = 'FV-2026-00042'),
  'Cancelled at the customer''s request'
);
```

It answers with one word: `cancelled`, `already_cancelled`, `already_paid`,
`illegal_transition` (the order is delivered or returned) or `not_found`.
`already_paid` means money has moved and cancelling would be a refund — that is
a decision, not a side effect, and refunds are Phase 8.

### Orders that cancel themselves

Every ten minutes the database looks for orders that have been `pending` and
unpaid for more than **thirty minutes**, cancels them, and puts their stock
back. This is not a bug when you see it: a customer who opens the card payment
window and closes the tab is holding stock that nobody is going to pay for, and
without the sweep anyone could empty the shop for free by doing that repeatedly.

It never touches an order whose payment is authorised but not yet settled, so
real money in flight is safe. If real traffic ever shows genuinely slow
settlements, the thirty minutes is one number in one migration.

### Cash on delivery

COD is offered on every order, with no minimum value and no PIN-code check.
Whether that is right is a business decision and it is yours to make; the hook
for it is described in `src/lib/payments/cod.ts`. Nothing marks a COD order paid
automatically — when the courier hands over the cash, set `payment_status` to
`paid` yourself.

---

## What is not built yet

Being straight about where the edges are:

- **The admin panel itself** — `/admin` is a placeholder that proves the lock
  works. Products, orders, inventory and the homepage builder are Phases 6 and 7.
  Orders are visible through `/account` and the Supabase table editor only.
- **Refunds** — nothing in the shop can issue one. A refund made in the Razorpay
  dashboard will not be reflected in the order. Phase 8.
- **Coupon codes** — the field is on the bag page and is visibly switched off,
  with a note saying so. **Nothing typed into it can change a total**, in either
  direction: no parameter carries it into the order. Phase 8.
- **Reviews** — Phase 8.
- **Order confirmation emails** — written and sent through an adapter, but the
  only adapter today prints to the server log. Nobody receives one until you
  connect a provider. See below.

---

## Four things only you can do

Nothing in the code can do these, and the shop is not finished until they are
done.

### 1 · Create the Razorpay webhook secret

Without it, card payments still work for a customer whose browser comes back to
the shop — but a customer who pays and then loses their connection is charged
and left with an order stuck at `pending`, and nothing reconciles it. The
webhook is what makes payment confirmation reliable.

**You invent this secret. Razorpay does not generate it for you.**

1. Make one: `openssl rand -hex 32`. Make a *different* one for Preview and for
   Production.
2. Razorpay Dashboard → **Account & Settings** → *Website and app settings* →
   **Webhooks** → **Add New Webhook**.
3. URL: `https://<your-domain>/api/payments/razorpay/webhook`. It must be public
   HTTPS — Razorpay cannot reach `localhost`.
4. Paste your secret into the *Secret* field.
5. Subscribe to exactly these four events: `payment.captured`, `payment.failed`,
   `payment.authorized`, `order.paid`.
6. Put the same string into Vercel as `RAZORPAY_WEBHOOK_SECRET`, **for Preview
   and Production separately**, then redeploy.

This is a different secret from `RAZORPAY_KEY_SECRET`, and confusing the two is
the single most common way this integration is got wrong. The symptom is that
every webhook is rejected, which looks like a network problem.

### 2 · Make one real test payment

Every branch around the card payment has been tested — the modal being
dismissed, the script being blocked, resuming an unpaid order, a captured
webhook, a forged signature, a replayed event. **What has never happened is one
real payment**, because that needs a human typing a test card into Razorpay's
own window. Do it once, in test mode, before you take a real order.

### 3 · Connect an email provider

Order confirmations are written and sent, but the only sender available today
prints them to the server log, so no customer receives one. Four steps:

1. Pick a provider that can send from your own domain. Resend is the least work
   alongside Vercel; any SMTP host works.
2. **Verify the sending domain** — an SPF record and a DKIM record on your DNS.
   Skipping this is what puts order confirmations in spam.
3. Put `EMAIL_API_KEY` and `EMAIL_FROM` (for example
   `Foot Vault <orders@your-domain>`) into Vercel, separately for Preview and
   Production.
4. A developer adds one file, `src/lib/email/<provider>-adapter.ts`, and returns
   it from `getEmailAdapter()`. Nothing else changes.

Until then a missing email never costs anybody their order — that is the
deliberate trade, not an oversight.

### 4 · Let search engines in

The whole site currently tells Google and everyone else to stay out. That is on
purpose: a shop indexed with placeholder pictures and a half-finished checkout
is a reputation problem that outlives the fix.

Three steps, and **please do not skip the third**. This is the one instruction in
this guide whose failure is completely silent: if you get it wrong, the deploy
succeeds, everything looks fine, and your shop stays invisible to Google.

**Step 1.** In Vercel → your project → *Settings* → *Environment Variables*, set

```
SITE_INDEXABLE = true
```

for **Production only**. Leave Preview alone, so preview builds stay hidden. Only
the exact word `true` opens the door, so a typo keeps you safely hidden rather
than accidentally visible.

**Step 2 — build fresh, do not just redeploy.** In Vercel → *Deployments* → the
`…` menu on the latest production deployment → **Redeploy**, and **untick "Use
existing Build Cache"**. Pushing any commit works too.

A normal redeploy is *not* enough. The instruction that tells search engines to
stay away is written into the site when it is built, not when it is served, so
reusing a cached build reuses the old instruction. Half the change takes effect
and half does not, and nothing warns you.

**Step 3 — check it actually worked.** Open a terminal and run these two, with
your real domain:

```bash
curl -I https://foot-vault.vercel.app/ | grep -i x-robots-tag
curl https://foot-vault.vercel.app/robots.txt
```

The first must print **nothing at all**. If it prints `x-robots-tag: noindex`,
step 2 did not take — redeploy again with the build cache unticked.

The second must show `Allow: /`. A few paths stay disallowed on purpose —
`/cart`, `/checkout`, `/account`, `/wishlist`, `/search`, `/order`, `/admin` —
because there is nothing on them for a search engine and they are different for
every visitor. That is correct and you should leave it alone.

One thing that will look wrong and is not: on Vercel **preview** deployments a
`x-robots-tag: noindex` header always comes back, whatever you set. Vercel adds
that itself to every preview so unfinished work never gets indexed. It does not
happen on your production domain.

There is also an optional fifth: Supabase Auth has **leaked-password protection
turned off**. It matters little while sign-in is Google-only, but it costs
nothing to turn on under *Authentication → Policies*.

---

## If something looks wrong

Every error page shows a **reference** — a short code like `676306073`. If a
customer sends you one, that code appears on the matching line in the server
log, and it is the fastest way for a developer to find exactly what broke.
