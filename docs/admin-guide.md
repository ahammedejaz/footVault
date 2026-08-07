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
homepage all follow whatever you put here.

---

## What is not built yet

Being straight about where the edges are:

- **Checkout and payment** — the Checkout button leads to a page that does not
  exist yet. Phase 5.
- **The admin panel itself** — `/admin` is a placeholder that proves the lock
  works. Products, orders, inventory and the homepage builder are Phases 6 and 7.
- **Coupon codes** — the field is on the bag page and is visibly switched off,
  with a note saying so. Phase 8.
- **Reviews** — Phase 8.

---

## If something looks wrong

Every error page shows a **reference** — a short code like `676306073`. If a
customer sends you one, that code appears on the matching line in the server
log, and it is the fastest way for a developer to find exactly what broke.
