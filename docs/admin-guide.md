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

## The admin panel

Sign in with Google, then go to **/admin**. If you are not an admin the page
simply does not exist — you get a 404, the same as any wrong address. That is
deliberate: a "you are not allowed in here" page tells a stranger there is
something worth coming back for.

It is built for a tablet. The menu is a permanent strip down the left from
tablet-portrait width up, and a drawer behind the ☰ button on a phone.

**What works today:**

| Page | What it does |
|---|---|
| **Dashboard** | Today's orders and takings, what needs fulfilling, what is running out. Every number is a link to the list behind it. |
| **Orders** | Every order. Search by order number, phone or email. Filter by status. |
| **Inventory** | Every size of every product, with its count. Tap a number to change it. |

**What does not work yet:** Products, Categories, Brands, Customers, Media and
Settings are in the menu but the pages are not built. Opening one gives you a
404. Adding and editing products still has to happen in the Supabase table
editor, exactly as before. The single order page — where the shipping buttons
will live — is also not built yet.

---

## Changing stock by hand

**Inventory → tap the number in the "In stock" column.**

A panel opens. It asks three things:

1. **How many, and which way.** Use − and + or type a number. Type a negative
   number to take stock away. It shows you the result before you save: *8 → 11*.
2. **Why.** "New stock arrived" for a delivery from a supplier; "Correcting the
   count" for damage, a miscount, or something put back on the shelf.
3. **A note.** This is required and it is not busywork — see below.

Underneath, the panel shows **everything that has ever happened to that size**:
every sale, every cancellation, every correction, who did it and when.

### Why the note is compulsory

Every change to stock — yours, a customer's purchase, an automatic release of an
abandoned order — is written into a permanent record. Nothing can change a stock
count without leaving a line in it, including somebody editing the number
directly in the database.

That record is the answer to the only question that ever matters about stock:
*the shelf says six and the website says four, what happened?* Without a reason
written down at the time, that question has no answer a month later. With one, it
takes ten seconds.

**A count you change by hand carries your name.** That is the point.

### It works in differences, not totals

If you count nine pairs on the shelf and the screen says seven, enter **+2**, not
9. This matters when two of you are working: if you both type totals, whoever
saves second wipes out the other's count without anyone noticing. Two
differences both land.

---

## Shipping — Shiprocket

**Nothing is built into the site that ships anything automatically, and that is
deliberate.** Shiprocket's system acts on your real account: creating an order
creates a real order in the Shiprocket panel, and assigning a tracking number can
commit real money to a courier. A bug that shipped parcels on its own would be
expensive. A person presses the button, every time.

### What you need to do first

The site cannot talk to Shiprocket until you do these four things. It is roughly
ten minutes.

**1. Create an API user.**

- Sign in to Shiprocket.
- **Settings → API → Configure**.
- Create a new API user.
- **Its email must be different from the email you sign into Shiprocket with.**
  This is the single most common thing to get wrong. If you reuse your own login
  email it will fail with an unhelpful "403" and nothing will explain why.
- Choose a password and write both down.

**2. Confirm your pickup address.**

- **Settings → Company → Pickup Addresses**.
- Make sure there is an address there — this is where couriers collect from.
- Note its **nickname** exactly as it is spelled, capitals and all. The site
  sends that word to Shiprocket as a literal string, so "Primary" and "primary"
  are different things.

**3. Send me those three values** — the API user's email, its password, and the
pickup nickname. They go into the site's settings as `SHIPROCKET_EMAIL`,
`SHIPROCKET_PASSWORD` and `SHIPROCKET_PICKUP_LOCATION`.

**4. Tell me whether your account has a test mode.** If it does we will use it
for the first shipment. If it does not, the first test creates one real order in
your panel, and you will cancel it there afterwards.

### Done — and what it turned up

Steps 1–3 are complete. The credentials work: the site signed in and got a pass
valid for exactly ten days, which it will now renew on its own.

Your pickup location is called **DCSR**, in **Cuddapah, PIN 516360**. Three
things follow from that, and two need a decision from you.

**The site now quotes delivery from 516360, not Bengaluru.** It had been set to
560001, which was a guess. Every delivery estimate and every cash-on-delivery
check is measured from where parcels are actually collected, so this had to
match or the answers would have been quietly wrong.

**Your shop's address was still the placeholder, and it is now fixed.** The
footer and contact page said *42 Commercial Street, Shivaji Nagar, Bengaluru
560001* — invented data from the very first build, never real. They now say:

> Classic Vastralayam Complex, Shop No. 2, Near RTC Bus Stand,
> Cuddapah, Andhra Pradesh 516360

and the phone is now **+91 91602 52643**, from your Shiprocket warehouse contact.

Two things about that you should check:

- I kept *Near RTC Bus Stand* and left out *peacock bar backside*. Both are in
  your Shiprocket record and both help somebody find the shop; the second one
  reads oddly on a shop website. Say the word and I will put it back.
- **Two placeholders are still there and still wrong:** the email
  `hello@footvault.in` and the WhatsApp number `+91 98450 22001`. Both are
  invented. Send me the real ones.

**Your pickup address is not verified in Shiprocket.** The panel reports it as
unverified, and Shiprocket can refuse to assign a tracking number to an
unverified address. Please verify it in the panel before we try a real shipment.

### What delivery actually costs you

Measured against your real account, for one 900g pair:

| Delivering to | Cheapest courier | Their price |
|---|---|---|
| Bengaluru | India Post Speed Post | **₹200.68** |
| Delhi | Amazon Shipping Surface | **₹207.34** |
| Srinagar | India Post Speed Post | **₹259.68** |
| Port Blair | *no courier serves this route* | — |

At the old ₹99 flat rate you were paying roughly ₹100 to ₹160 per order out of
your own margin, and the whole ₹200-odd on anything over ₹1,999 where delivery
was free.

**That has now changed on your instruction, and delivery is priced per order.**

**Paying online**

- **₹2,499 and above — free.**
- Below that, the customer pays what the courier charges to reach them,
  rounded up to the nearest ₹10. India Post is never used for pricing.

**Cash on delivery**

- **Charged on every order, whatever the value. No free threshold.**
- The charge is the delivery *plus the return leg*, because a refused COD
  parcel costs you both ways and earns nothing.

Measured live against your account today, for one pair:

| To | Bag | Online | COD |
|---|---|---|---|
| Bengaluru | ₹1,999 | ₹210 | ₹350 |
| Bengaluru | ₹3,000 | **free** | ₹390 |
| Delhi | ₹1,999 | ₹160 | ₹270 |
| Port Blair | any | *refused — no courier goes there* | *refused* |

Two things worth noticing. Delhi is **cheaper** than Bengaluru, because a
different courier wins there — so a flat rate was always over-charging some
customers and under-charging others. And the COD figure grows with the basket,
because Shiprocket takes 3% of the order value for collecting cash.

**If Shiprocket cannot be reached** the customer pays ₹199 online or ₹349 COD,
and the sale still goes through. A courier outage never stops you selling.

**Pin codes with no service are now refused at checkout**, before any money
moves, as you asked.

Port Blair is worth knowing about separately: no courier will carry from
Cuddapah to the Andamans at all. The site now spots that and does not offer cash
on delivery for addresses it cannot reach.

### About the old key

There was a value called `SHIPROCKET_API_KEY` in the site's settings. **It does
not work and it never did** — it was checked against Shiprocket directly and
came back "unauthorized". Shiprocket's system does not use a fixed key at all; it
uses the email and password above to issue a pass that lasts ten days, which the
site renews on its own. That old value has been removed.

### What the site does with it, once configured

- **On the checkout page**, it asks Shiprocket whether any courier will collect
  cash at the customer's PIN code. If none will, Cash on Delivery is not offered
  for that address, and the customer is told to pay online instead.
- **If Shiprocket is slow or down, nothing is blocked.** Cash on Delivery stays
  available and the delivery estimate falls back to the default. A problem at the
  courier must never cost you a sale.
- **What you charge for delivery does not change.** Flat ₹99, free over ₹1,999,
  exactly as before. The courier's real cost is recorded for you to look at; it
  is not passed to the customer. That is your decision to make, not the site's.

### Fulfilling an order — not available yet

The five steps (create the shipment, assign a tracking number, book a pickup,
print the label, track the parcel) are written and tested, but the page with the
buttons on it is not built. **You cannot fulfil an order from the panel yet.**
Until that page exists, shipping is done in the Shiprocket panel directly, as it
was before.

The click-path for testing it against your real account will be written here once
the buttons exist and the credentials above are in place.

---

## What is not built yet

Being straight about where the edges are:

- **Most of the admin panel.** Dashboard, Orders and Inventory work. Products,
  Categories, Brands, Customers, Media and Settings are in the menu and 404 when
  opened — adding and editing products is still done in the Supabase table
  editor. The single-order page is not built either, which is why there are no
  shipping buttons yet.
- **The homepage builder and banner scheduling** — Phase 7.
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
