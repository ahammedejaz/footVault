# Foot Vault — the owner's guide

Written for the person who runs the shop, not for a developer.

Read the first section before you take another Pay-on-Delivery order. The way
money arrives changed this month, and a customer will ask you about it.

**When this guide says "ask your developer", it means it.** Some jobs still need
somebody with access to the site's settings or the database. Those are marked.
Everything else you can do yourself, from the tablet.

---

## 1 · Pay on Delivery — how the money now works

### What changed

It used to be called Cash on Delivery, and it meant exactly that: the customer
paid nothing, the order was accepted, a pair came off your shelf, and you found
out at the door whether there was any money at the end of it. If the parcel was
refused you had paid to send it and paid to get it back, and collected nothing.

It is now called **Pay on Delivery**, and it works like this:

1. The customer pays the **delivery charge** online, by card or UPI, at the
   moment they order.
2. **The order is not placed until that payment goes through.** If it fails, no
   order exists and nothing comes off your shelf.
3. The courier collects **the rest in cash** at the door.

So every order in the shop now has money against it before anything is packed.

### A real order, in numbers

This is order **FV-2026-00513**, a test order, and the figures are the real ones:

| | |
|---|---|
| The shoes | ₹6,495 |
| Delivery | ₹349 — of which ₹150 is the Pay-on-Delivery extra |
| **Order total** | **₹6,844** |
| **Paid online, before the order existed** | **₹349** |
| **The courier must collect** | **exactly ₹6,495** |

The number that matters at the door is **₹6,495**, not ₹6,844. The customer has
already paid ₹349. If the courier collects the full total, that customer has
been charged the delivery twice and you will be giving it back.

You do not have to work this out. The order page names both figures — what was
paid online and what is due at the door — and the same balance is what
Shiprocket is told to collect.

### Why the shop takes the delivery charge upfront

Because a refused parcel is not a neutral event. Measured against your own
Shiprocket account, one pair to Bengaluru costs about **₹205 to send and about
₹142 to get back**. If nobody pays anything upfront and the parcel comes back,
that is roughly **₹350 gone**, and you still have the shoes.

Taking the delivery charge before the parcel moves is what turns that from a
loss into a break-even. It is also why the Pay-on-Delivery delivery charge is
higher than the online one: it covers the journey out **and** the journey back.

The charge is not a penalty and it is not profit. It is the round trip.

### What to say when a customer rings

- *"You pay only the delivery charge now. The rest is cash to the delivery man."*
- *"Please keep exactly ₹6,495 ready. That is the amount without the delivery,
  because you have already paid that part."*
- *"Paying the whole amount online is cheaper, and above ₹2,499 the delivery is
  free."*
- *"The delivery charge is not returned if you refuse the parcel. It pays the
  courier to bring it to you and to take it back."*

### One thing that looks wrong and is not

A brand-new Pay-on-Delivery order sits at **pending** for a few seconds before it
turns **confirmed**. That is the advance being confirmed by the bank. Both kinds
of order behave the same way now. An order that stays `pending` and unpaid for
half an hour cancels itself and puts the shoes back on the shelf — see
[Orders](#5--orders-day-to-day).

---

## 2 · The delivery charge, and what you control

### You never set a delivery rate. Ever.

**Delivery prices come from Shiprocket, live, for the customer's own pin code.**
Nobody types them in — not you, not your developer. There is no rate card in this
shop to keep up to date, and no number to correct when a courier changes its
prices.

The site asks Shiprocket what the cheapest courier charges to reach that pin
code, rounds it up to the nearest ₹10 so the customer never sees ₹210.68, and
shows it before they pay. Delhi sometimes comes out cheaper than Bengaluru,
because a different courier wins there. That is correct, and it is why a single
flat rate was always overcharging some customers and undercharging others.

If Shiprocket says **no courier serves that pin code at all**, checkout says so
before any money moves. From Cuddapah, Port Blair is one of those.

### What you do control

These live in **Settings → Delivery and Pay on Delivery** in the admin panel.
Change one and the whole site follows it at once — the bag, the checkout page,
the emails, the announcement strip, the policy pages. Every control on that
screen says what it does *and* what happens if you set it too high or too low.

| What it decides | Today |
|---|---|
| The order value at which delivery becomes **free**, for customers paying online | **₹6,499** |
| Whether Pay on Delivery is offered at all | **on** |
| The **smallest order** that may pay on delivery | **₹999** |
| The **most** that may ever be taken upfront | **₹500** |
| Whether the 18% GST on delivery is recovered in the upfront amount | **absorbed** |
| The discount for paying online | **none** |
| How the delivery charge is decided | **the courier's live rate** |
| What a customer who paid online gets back when a parcel comes back | **everything except what the journey cost** |
| The stand-in delivery charge used only when Shiprocket cannot be reached | **₹199** online, **₹349** Pay on Delivery |

**Free delivery is for people paying online only.** A Pay-on-Delivery order is
charged for delivery whatever it is worth.

## How the upfront amount works, in one paragraph

**The customer pays the full round trip online — what it costs to send the
parcel plus what it costs to get it back — and that amount is taken off what the
courier collects.** So they pay the same total either way; only the timing
changes. If the parcel is refused at the door you are already covered: you keep
the upfront amount, and it is exactly what the two journeys cost you.

On a ₹1,000 order to Bangalore, at the rates this account was quoted on 8 August:
delivery ₹200, upfront ₹281.36, courier collects ₹918.64, customer pays ₹1,200
either way. Refused, you keep ₹281.36 and pay ₹281.36. Net zero, shoes back on
the shelf.

**You no longer choose how the upfront amount is worked out.** There used to be
three ways — the delivery charge, a fixed sum, or whichever was larger — and all
three priced it from what the *customer* was charged, which has nothing to do
with what a refusal costs you. Under a fixed ₹99 against a ₹281 round trip you
lost ₹182 on every refused parcel and only found out by counting. What you set
now is the two **bounds**: the smallest order allowed to pay on delivery, and the
most you are ever willing to ask for upfront.

**The smallest order matters more than it looks.** Below it, Pay on Delivery is
not offered at all — not offered with a smaller deposit. A smaller deposit would
mean you are carrying a return you have not been paid for, and on a ₹250 pair of
flip-flops the round trip is more than the shoes.


It is a safety net rather than something that fires every day: as the settings
stand, a Pay-on-Delivery order is always charged for delivery, so the delivery
charge is nearly always the larger of the two. The floor is what catches you if
that ever changes. Setting it to zero would quietly undo the whole model, so the
site refuses to go below ₹1 whatever is typed in.

**The stand-in charges are not a price list.** They are used only in the minutes
when Shiprocket is unreachable, so a courier outage never stops you selling. The
test order in section 1 was priced this way: ₹349 is ₹199 plus the ₹150 return
leg, which is why it is not a round ₹10 figure like a live quote would be.

---

## 3 · Returns, refunds and replacements

You will have to say this out loud to customers, so it is written the way you
would say it.

### The policy, in four lines

- **No refunds.** Not for a change of mind, not for size, not for colour.
- **No returns through the website.** There is no return button and no pickup
  will be arranged. Everything happens by the customer contacting the shop.
- **No size exchanges.** This is why the size guide is on every product page.
- **A replacement, for damage in transit only** — and only if the customer
  contacts the shop **within 24 hours of the parcel being delivered.**

The full wording is on the site at **/page/returns**, and it is the version a
customer will quote at you, so read it once.

### The 24 hours are now a real deadline, and the customer can see it

"Within 24 hours of delivery" is useless to a customer who does not know when the
courier marked it delivered. So the site now does the arithmetic for them.

Once the courier records the parcel as delivered, the customer's order page shows
a line like:

> **Damaged item?** Contact us before **4:30 PM tomorrow** and we will replace it.

That time is counted from the **courier's own delivery timestamp**, not from when
anyone happened to look at the page. It updates itself, so a page left open does
not still claim there is time after the deadline has passed.

**After it lapses, the same box changes.** It stops offering a replacement and
shows the shop's **phone number and WhatsApp button** instead, with a line saying
you would still rather hear about it. So a customer who is a day late will ring
you, not give up quietly. Expect those calls, and answer them on their merits —
the site is not deciding anything, it is only stating the deadline.

**Nothing about a replacement is automatic.** There is no button a customer can
press to demand one. The decision is yours, taken by a person.

### What to ask a customer for

Ask for all five. The courier will not accept a damage claim without the first
two, and you cannot assess the pair without the rest.

1. **Photographs of the damage** — the pair itself, clearly.
2. **Photographs of the packaging** — the outer box and the courier label as it
   arrived.
3. **Keep the box.** Do not let them throw the packaging away.
4. **Do not wear the pair.** A sole that has been outside cannot be assessed or
   replaced.
5. **The order number** — it looks like `FV-2026-00513`.

If you agree it was damaged in transit, you send the same item in the same size,
if you hold it. If you do not hold it, you agree something with the customer
directly.

### Two things to fix before this can work properly

- **The WhatsApp number and email address on the site are still made-up.** They
  are `+91 98450 22001` and `hello@footvault.in`, invented during the first
  build. The WhatsApp button on that replacement box points at the invented
  number. Send your developer the real ones. This is not cosmetic — it is the
  only route a customer has for a claim.
- **The phone number and shop address are correct**, taken from your Shiprocket
  record: Classic Vastralayam Complex, Shop No. 2, Near RTC Bus Stand, Cuddapah,
  Andhra Pradesh 516360, and **+91 91602 52643**.

### One refund the site still promises, deliberately

If a size sells out between the order being placed and being packed, that money
is returned. That is not a return — it is money taken for goods that will never
be sent, and keeping it was never an option. The no-refund policy does not cover
that case, and it does not override Indian consumer law either. The site says so.

### Sending money back, from the order page

Since Batch 3 there is a panel called **The money back** on each order's page,
under the money summary. It appears only on orders where something was actually
paid online. You never type an amount:

1. Open the order and find the panel.
2. Pick **why** the money is going back — either *the order stopped* (cancelled,
   refused at the door, undeliverable) or *our mistake* (wrong item, wrong size,
   damaged before it was dispatched). That is the one thing only you can know.
3. The panel shows the amount, computed from where the order stopped, with every
   deduction listed — for example the delivery journeys on a parcel that came
   back. Read the explanation; it is the same sentence you can say to the
   customer.
4. Press the button, then press it again to confirm. The money goes back along
   the same payment the customer made.

**"Waiting for Razorpay" is normal.** A refund is only marked returned when
Razorpay confirms it — usually within moments, sometimes minutes. The page
updates itself on refresh.

**A Pay-on-Delivery order refunds at most the advance**, because the advance is
all the shop ever held — the cash balance was collected by the courier or never
collected at all. The panel does this arithmetic for you and will not let you
send more than was taken.

**If you refunded in the Razorpay dashboard instead** — or ever did in the past
— press **Check Razorpay** on the same panel. It pulls every refund Razorpay
holds for the order into the page, so the record stops being wrong. Do this once
for any order you refunded by hand before this existed.

---

## 4 · Shiprocket — the jobs only you can do

This is the section with real work in it. Until it is finished, no parcel can be
booked from the site.

### Where things stand

- The site can already sign in to your Shiprocket account, and it prices delivery
  from it live. That part works.
- Your pickup location is **DCSR**, Cuddapah, PIN 516360.
- **Your pickup address is not verified in Shiprocket.** The panel shows it as
  unverified, and Shiprocket can refuse to issue a tracking number for an
  unverified address. Verify it in the panel before you try a real shipment.
- **The site has never booked a real parcel.** The test in 4.5 below is the one
  that proves it, and it has not been run.

### 4.1 · Create an API user in Shiprocket

You need this so the site can talk to your account. Do it once.

1. Sign in to the Shiprocket panel.
2. Go to **Settings**.
3. Open **API**.
4. Click **Configure**.
5. Create a **new API user**.
6. **Give it an email address that is different from the one you sign into
   Shiprocket with.** This is the single most common mistake, and Shiprocket does
   not tell you that is the problem — it just refuses everything. Any address you
   control will do; it never receives post.
7. Set a password. **Write both down.**

### 4.2 · Confirm your pickup location

1. In the Shiprocket panel, go to **Settings**.
2. Open **Company**.
3. Open **Pickup Addresses**.
4. Check there is an address there. This is where couriers come to collect.
5. Write down its **nickname exactly as it is spelled**, capital letters and all.
   Yours is **DCSR**. The site sends that word to Shiprocket letter for letter,
   so "DCSR" and "dcsr" are two different things to it.
6. While you are on this screen, **get the address verified**. See the note above.

### 4.3 · Hand three things to your developer

The API user's **email**, the API user's **password**, and the **pickup
nickname**. Your developer puts them into the site's settings. Nothing else is
needed from you.

**Why an API user and not a key.** Shiprocket does not hand out a permanent key.
It issues a pass that **expires every 10 days**. If the site were built around
one of those, everything would work perfectly for ten days and then every
shipping action would fail at once, with no change to explain it. An API user's
email and password let the site fetch itself a fresh pass whenever it needs one,
so this never happens.

There was an old value called `SHIPROCKET_API_KEY` in the site's settings. It
authenticated nothing and never had. It has been removed.

### 4.4 · No test mode, as far as anyone can tell

Shiprocket does not appear to offer a sandbox or practice mode for this account.
**If you find one in the panel, say so** — it would be better than what follows.
Assume there is not one, which is why the test below is written to be small,
obvious and reversible.

### 4.5 · The one manual test — not yet run

**Read this before starting: every step acts on your real Shiprocket account and
creates a real order in your panel. Cancelling it at the end is what makes it
safe. Do not skip step 7.**

Place one small test order on the site first — your own address is fine — then:

1. Open the site's admin panel and find that order.
2. Press **Create shipment**. The order should now appear in your Shiprocket
   panel.
3. Press **Assign AWB**. This is the tracking number, and this is the step that
   commits the parcel to a courier.
4. Press **Generate label**. You should get a printable label back.
5. Press **Fetch tracking**. It should come back with a status, most likely
   "pickup scheduled" or similar.
6. Check the Shiprocket panel: the order, the tracking number and the label
   should all be there, and the amount to collect should match what the site
   says the courier must collect.
7. **Cancel the order in the Shiprocket panel.** Find it, cancel it, and confirm
   it is cancelled. Do this the same day.

**Do not press "Book pickup" during the test.** There are five buttons in all,
and that fifth one is the one that actually asks a courier to come to your shop.
Leave it alone until you are shipping a genuine order — a courier arriving for a
parcel that does not exist is the one part of this that is awkward to undo.

Pressing any of the other buttons twice is harmless — the site notices the step
is already done and does nothing. That is deliberate, so a slow connection cannot
create two parcels.

**You cannot run this test yet.** Steps 1 to 5 need the buttons, and the buttons
live on the order detail screen, which is not built. See section 7.

Nothing in the site ever ships anything by itself, and that will not change. A
person presses each button, every time, because a mistake here costs real money
and creates a real parcel.

---

## 5 · Orders, day to day

### Where to look

**Admin panel → Orders.** Every order, newest first. Search by order number,
phone or email. Filter by status.

Click an order to open it. The single-order screen carries the money summary,
the refund panel (§3), the Shiprocket buttons, the RTO panel when a parcel is
coming back (below), replacements and notes. The claim that used to sit in this
paragraph — that no such screen existed — was three phases stale.

A customer sees their own orders at **/account/orders**. You cannot see somebody
else's that way, even as an admin. That is deliberate.

### What the statuses mean

| Status | Means |
|---|---|
| `pending` | The order exists and the shoes are reserved, but the money has not arrived yet. **Both kinds of order start here now** |
| `confirmed` | The money arrived. For Pay on Delivery that means the delivery charge cleared |
| `packed` | You have picked and boxed it |
| `shipped` | It is with the courier |
| `delivered` | It arrived. **This is when the 24-hour replacement clock starts** |
| `cancelled` | It will not happen. Cancelling puts the shoes back on the shelf automatically |
| `returning` | The courier reported the parcel is coming back to you — refused at the door, undeliverable, or cancelled in transit. It is in a van, not on your shelf |
| `returned` | It is physically back with you |

`cancelled` and `returned` are final. An order that has to come back from either
is a new order, not an edited one.

### When a parcel comes back (RTO)

The shop notices on its own: when tracking is refreshed and the courier's
status says RTO, the order moves to `returning` and appears under **Returns to
origin** in the menu. Nothing else happens automatically — and that is the
design, because parcels are lost and damaged on the way back, and restocking on
a courier's say-so invents stock you do not have.

When the box is physically in your hands, open the order:

1. **Mark it received**, and say whether the contents are **fine** or
   **damaged**. Damaged needs a note — what you found is the only record there
   will be.
2. If it was fine, press **Put the stock back**. The pairs return to the shelf
   and the stock ledger records each one, with your name on the entry. The
   button is safe to press twice; the second press tells you it is already
   done.
3. If it was damaged, there is nothing to press — the write-off is the note
   you just made, and damaged pairs never re-enter stock.
4. **Type in what Shiprocket actually charged** for the return journey, from
   their panel, next to the estimate the site quoted. Refunds for the customer
   compute from the actual figure once you have entered it.

The **Returns to origin** screen totals what coming-back parcels are costing
you, shows which PIN codes they come from, and flags any phone number that has
done it more than once — those are the customers to stop offering Pay on
Delivery to (§1).

### Orders that cancel themselves

Every ten minutes the shop looks for orders left unpaid for more than **thirty
minutes**, cancels them and puts the shoes back. This is not a fault. A customer
who opens the payment window and then closes the tab is holding stock nobody is
going to pay for, and without this anyone could empty your shelves for free.

It never touches an order where money is genuinely in flight.

### Cancelling and status changes

Both are buttons on the order screen now, and only the legal next steps are
drawn. Cancelling a **paid** order refuses until the money is dealt with — the
message points you at the refund panel with the exact amount. **Never ask for
an order to be edited directly in the database** — cancelling has to put the
stock back exactly once, and the buttons go through the machinery that does.

---

## 6 · Stock

**Admin panel → Inventory.** One row per size, with its count. Tap the number to
change it.

A panel opens and asks three things:

1. **How many, and which way.** Use − and + or type a number. A negative number
   takes stock away. It shows the result before you save: *8 → 11*.
2. **Why.** "New stock arrived" for a delivery from a supplier, or "Correcting
   the count" for damage, a miscount, or something put back on the shelf.
3. **A note.** This is compulsory.

Underneath, the panel shows **everything that has ever happened to that size** —
every sale, every cancellation, every correction, who did it and when.

### Every change is recorded, without exception

Every movement of stock leaves a permanent line: yours, a customer's purchase, an
order that cancelled itself, a return you put back — **and the stock a product
starts with on the day it is created**. Nothing can move a stock count without
being written down, including somebody editing the number straight in the
database.

That record answers the only question that ever matters about stock: *the shelf
says six and the website says four — what happened?* Without a reason written at
the time, that question has no answer a month later. With one it takes ten
seconds.

**The note is what a future person reads**, and that person may well be you in
March. "Correction" tells them nothing. "Two pairs water-damaged, monsoon leak"
tells them everything. Your name goes on it either way.

### Count differences, not totals

If you count nine pairs and the screen says seven, enter **+2**, not 9.

This matters when two people are working. If you both type totals, whoever saves
second wipes out the other's count and nobody notices. Two differences both land.

---

## 7 · What is not built yet

So you are not hunting for something that is not there. This list was rewritten
in Batch 3; the earlier version predated the order screen and undersold what
works.

**In the admin panel, these work:** Dashboard, Orders, the **single order
screen** (money, shipping buttons, replacements, notes, and since Batch 3 the
refund panel), Inventory, and **Settings** — delivery rates, the parcel box,
Pay on Delivery controls.

**Still in the menu but opening to "page not found":** Products, Categories,
Brands, Customers, Media. Adding and editing products still happens in the
database, not in the panel.

**Also not built:** coupon codes (the box on the bag page is visibly switched
off and nothing typed into it can change a total), reviews, and the homepage
builder (`/admin/appearance` — promised, still owed, scheduled as Batch 5).

**Order confirmation emails are written but nobody receives them.** No email
provider is connected yet — see 8.3.

---

## 8 · Other jobs waiting on you

Shiprocket (section 4) is the big one. These four are the rest.

### 8.1 · The Razorpay confirmation setting — ask your developer

**This one matters more than it sounds.** Today the shop only learns that a
payment succeeded because the customer's phone comes back to the site and says
so. If their connection drops at that moment, they have been charged and their
order sits stuck as unpaid, with nothing to sort it out.

The missing piece lets Razorpay tell the shop directly, phone or no phone. Your
developer will call it the **webhook secret**. Without it, payment confirmation
is reliable only when the customer's internet is.

It has to be set up in your Razorpay dashboard and in the site's settings
together. Your developer needs to do both. Tell them the value is currently
blank.

### 8.2 · One real test payment

Every possible failure around card payment has been tested. What has never
happened is **one real payment on the new Pay-on-Delivery flow**, because that
needs a person typing a test card into Razorpay's own window. Do it once, in test
mode, before you take a real Pay-on-Delivery order — and check the three figures
on the confirmation: paid now, due at the door, total.

### 8.3 · Connect an email provider — ask your developer

Order confirmations are written and sent, but the only sender configured today
writes them to a log file, so no customer receives one. Your developer needs an
account with an email provider and a couple of DNS records on your domain,
otherwise confirmations land in spam.

Until then a missing email never costs anybody their order.

### 8.4 · Let search engines in — ask your developer, when you are ready

The whole site currently tells Google to stay away. That is on purpose: a shop
indexed with half-finished pages is a reputation problem that outlives the fix.
When you are ready to be found, your developer flips one setting and rebuilds.

**It is worth checking afterwards**, because if it is done wrong nothing warns
you — the site looks perfectly fine and stays invisible. Ask them to confirm it
took effect on the live site, not just that they changed the setting.

### And one small thing

Supabase has a "leaked password protection" option switched off. It matters
little while everyone signs in with Google, but it costs nothing to turn on.

---

## 9 · Getting into the admin panel

You need this once, and it needs your developer or the Supabase dashboard.

1. **Sign in to the shop first**, with Google, using the address you want to be
   the admin. This must happen first — you are promoting an account that has to
   already exist.
2. Ask your developer to run this one line, with your address in it:

   ```sql
   select private.promote_to_admin('you@example.com');
   ```

3. Go to **/admin**. You should see the panel. If you still get "page not found",
   sign out and back in — your browser is holding a session from before the
   change.

**If you are not an admin, /admin looks like a page that does not exist.** That
is deliberate. A "you are not allowed in here" page tells a stranger there is
something worth coming back for.

This is not a button on a screen, and it never will be. Anything that can grant
admin rights over the web is something an attacker can try to reach over the web.
It lives outside the part of the database the website can talk to, so the only
way to run it is to already be signed in to Supabase as the account owner.

The same line promotes anybody else. Removing someone's admin rights is a similar
one-line job for your developer.

---

## 10 · Signing in, and the announcement strip

**Customers sign in with Google and nothing else.** No password to forget, no
reset email, no registration form. And **customers never need an account to
buy** — signing in only keeps a bag across phones, saves a list, and puts past
orders in one place. Checkout stays open to guests on purpose.

**The thin strip above the header** is text stored in the database. Ask your
developer to change it. Two things to know:

- When the words change, **everyone sees the new one**, including people who
  closed the old one. Closing one message must not hide next month's.
- **It must never promise returns or refunds.** It used to say "Free returns
  within 7 days", which was never your policy.

---

## 11 · If something looks wrong

Every error page shows a **reference** — a short code like `676306073`. If a
customer sends you one, that code appears on the matching line in the site's log,
and it is the fastest way for a developer to find exactly what broke.

Send them the code, the order number, and what the customer was doing.

---

## 12 · Backups, and the snapshot taken before every change

**The shop's order records exist in exactly one place.** Razorpay knows what it
charged and Shiprocket knows what it shipped, but only this database knows that
those two facts belong to the same customer. If it is lost, it cannot be
rebuilt from the other two.

### What is running today

Two things are confirmed switched on, read directly from the database rather
than taken on trust:

| | |
|---|---|
| Write-ahead log archiving | `archive_mode = on`, shipping to Supabase's `wal-g` |
| Log detail level | `wal_level = logical` |

That is the machinery continuous backup is built from, and it is running.

**What it does not tell you.** Supabase runs that archiving on every project on
every plan, so seeing it on does **not** mean point-in-time recovery is
available to you, and it does not reveal how many days of history you can reach.
Those two numbers live only in the dashboard, under **Database → Backups**.
Worth reading once and writing down.

**Point-in-time recovery is deliberately not being bought this phase.** It is
the right purchase once real orders are flowing daily; today the shop has taken
one live order. The snapshot below is what covers the gap in the meantime, and
it covers the specific risk that actually exists right now — a migration going
wrong — rather than the general one.

### The rule

**A snapshot is taken immediately before any change that alters the database's
structure, and it is not started until the snapshot file exists and has a
sensible size.** Not the same day. Immediately before.

This is a developer's job, and it is four lines.

### Taking one

```bash
# Session mode, port 5432 — the transaction pooler on 6543 cannot do this.
export FV_DB_URL='postgresql://postgres.ahumjhwqgmskjsitctcj:PASSWORD@aws-0-ap-south-1.pooler.supabase.com:5432/postgres'

npx supabase db dump --db-url "$FV_DB_URL" -f "backup-$(date +%Y%m%d-%H%M)-schema.sql"
npx supabase db dump --db-url "$FV_DB_URL" -f "backup-$(date +%Y%m%d-%H%M)-data.sql" --data-only

ls -lh backup-*.sql   # both files non-empty before going any further
```

The password is the database password from **Project Settings → Database**. It
is not the service-role key and not the anon key; those three are different
things and only this one opens a direct connection.

**Copy the connection string from the dashboard's Connect button rather than
typing the one above.** The host shown here is the right *shape*, but Supabase
spreads projects across several regional pooler endpoints and only the dashboard
knows which one is yours. The old direct host, `db.<ref>.supabase.co`, no longer
resolves for this project at all — the pooler is not a preference, it is the
only way in.

**One trap, and it will bite quietly.** The server runs PostgreSQL 17.6. A
`pg_dump` older than that refuses to dump it — the machine this was written on
had version 14 installed, which fails. `npx supabase db dump` is used above
precisely because it runs the correct version itself. If you prefer plain
`pg_dump`, check `pg_dump --version` reads 17 or higher first, and install
`postgresql@17` if it does not. A version mismatch fails loudly, which is the
good case; the bad case is reaching for a dump months later and discovering it
was never taken.

### Putting one back

Restoring is not a thing to improvise at the moment you need it, so the order is
written down here.

1. **Stop writes first.** Pause the site in Vercel, or the restore races live
   traffic and you end up with a database that is neither the old one nor the
   new one.
2. **Decide what you are undoing.** A failed migration usually needs the schema
   only; the rows are typically intact and re-importing them would throw away
   every order taken since the snapshot.
3. **Restore into a new Supabase project first, never straight over production.**
   Confirm it looks right there.

   ```bash
   npx supabase db reset --db-url "$RESTORE_TARGET_URL"
   psql "$RESTORE_TARGET_URL" -f backup-YYYYMMDD-HHMM-schema.sql
   psql "$RESTORE_TARGET_URL" -f backup-YYYYMMDD-HHMM-data.sql   # only if rows are needed
   ```

4. **Check three things before switching anything over**: the order count matches
   what you expect, `select count(*) from payment_events` is not zero, and stock
   reconciles — `docs/rls-tests.md` has the query.
5. **Then** repoint `NEXT_PUBLIC_SUPABASE_URL` and the keys, and redeploy.

### Where the files go

**Not in the repository.** A data dump holds real customers' names, addresses
and phone numbers, and the repository is the one place guaranteed to be copied
onto other machines. Keep them somewhere private with the date in the filename,
and delete ones older than a couple of months — an old dump of real addresses is
a liability, not a safety net.
