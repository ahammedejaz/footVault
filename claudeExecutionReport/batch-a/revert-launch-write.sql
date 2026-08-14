-- Restores the three pages to exactly what production held before the
-- 2026-08-14 launch write. Generated from the rows themselves.

UPDATE pages SET body = 'The quickest way to reach us is WhatsApp. We answer during shop hours, usually within the hour.

Prefer email? Write to {{contact_email}}. Replying to any email we have sent you about an order lands in the same inbox, so you can simply hit reply.

For an order that already exists, send the order number — it looks like FV-2026-00147 — and we can pull it up straight away.

**If a parcel has arrived damaged, ring or send a WhatsApp message rather than emailing.** That claim closes {{return_window}} after delivery, and an email may not be read in time. The returns page lists what to send us.

You are welcome to come to the shop and try a pair on. We are in Kadapa — still widely written Cuddapah — in Andhra Pradesh, and the address and our opening hours are below.' WHERE slug = 'contact';

UPDATE pages SET body = 'These terms apply when you buy from Foot Vault. The shipping and returns pages are part of the same agreement, so read those too — between them they cover most of what people actually write in to ask.

**Who you are buying from.** {{registered_name}}, GSTIN {{gstin}}, trading as Foot Vault from the address on our contact page.

**Prices.** Prices are in Indian rupees and include all taxes. The price shown in your bag is the price you pay. Delivery, where it is charged, is shown separately before you pay and is never added at the last step.

**When an order becomes an order.** Placing an order is an offer to buy. It becomes a contract when we confirm it, not when you press the button and not when the payment is taken. Until then we may decline it — the usual reasons are stock, an address no courier will serve, or a payment we cannot verify — and anything you have paid comes straight back.

**Stock.** The counts on this site are live. Where a product page says two are left in your size, that is the number on the shelf. If something still sells out between your order and our packing it, we will tell you which item and return that line in full.

**Mistakes in a price or a description.** We check both, and occasionally one is still wrong. Where a price or a description is obviously mistaken we are not obliged to sell at it. If we notice after you have paid, we will tell you, and you can either accept the corrected price or have your money back in full.

**Cancelling before dispatch.** Write or ring before we have handed the parcel to the courier and we will cancel the order and return what you paid in full, including any delivery you paid for. Once it is on the road it cannot be cancelled.

**Delivery.** We dispatch from our shop and the courier carries it from there. The dates you are shown come from that courier and are their estimate, not a guarantee — a strike, a flood or a closed road is not something we can promise around. What we do promise is that we hand it over on time, and that we tell you when we have.

**Replacement, not refund.** We do not offer refunds — not on change of mind, not on size, not on colour. If a pair arrives damaged we will replace it, provided you tell us within {{return_window}} of delivery. We cannot exchange for a different size. The returns page sets out the conditions in full, and they are conditions rather than formalities.

**When the fault is ours.** The wrong shoe, the wrong size, an item we cannot supply, or damage that happened before it left us: you get everything back with nothing deducted. That is not a change of mind and we do not treat it as one, so the rule above does not apply to it.

**Your statutory rights.** Nothing on this page or anywhere else on this site affects your rights under the Consumer Protection Act, 2019 or any other law of India.

**Law and jurisdiction.** These terms are governed by the laws of India. The courts at Kadapa (Cuddapah), Andhra Pradesh have exclusive jurisdiction over any dispute arising out of them.' WHERE slug = 'terms';

UPDATE pages SET body = 'This page says what we collect when you buy from Foot Vault, why we hold it, who else sees it, and what you can ask us to do with it. It is written to be read rather than filed.

**What we collect.**

- Your name, delivery address, phone number and email address. A parcel cannot be delivered without them.
- What you ordered, what you paid, and how you paid.
- Your account, if you make one — the same details, plus your order history.
- Your bag, held against a token in your browser until you sign in, at which point it moves to your account.
- The ordinary technical record every website keeps: your IP address, your browser, and which pages you asked for.

We never see your card details. They pass from your browser to our payment processor and do not reach us.

**Why we hold it.** To pack and deliver your order, to contact you about it, to take and return payment, to show you your order history when you sign in, to answer you when you get in touch, and to keep the sales records the law requires us to keep.

**Who else sees it.** Running a shop that delivers means other companies handle parts of it. These are all of them, and what each one gets.

- **Razorpay** takes the payment. They receive the amount, the order reference, and whatever you type into their payment form.
- **Shiprocket** arranges the delivery. They receive your name, full address, phone number and what is in the parcel, and they pass those to whichever courier collects it.
- **Resend** sends our email. They receive your email address and the contents of each message we send you.
- **Supabase** hosts our database and runs the sign-in. Your account, orders and addresses are stored there.
- **Google** signs you in, if you choose "Continue with Google". Google tells us who you are and gives us your name and email address. We never receive your Google password.
- **Vercel** serves this website. Every request passes through them and is logged, which includes your IP address.

We do not sell your data, and we do not pass it to anyone for advertising.

**How long we keep it.** Order records are kept for as long as tax and company law requires us to keep sales records — we cannot delete an invoice on request, and neither can any shop. Everything else is kept while your account exists. Server logs are short-lived and are not used to build a profile of you.

**Cookies.** This site sets what it needs and nothing more: one to keep you signed in, and one to remember your bag before you sign in. There is no advertising cookie and no third-party tracker on this site. If that ever changes, this page changes with it and says so.

**What you can ask for.** You can ask us for a copy of what we hold about you, ask us to correct anything that is wrong, ask us to delete your account, or withdraw a consent you have given. You can also tell us who may act for you if you are unable to.

**Deleting your account.** Write to {{contact_email}} from the address on the account, and we will confirm once it is done. We will remove it within {{deletion_window}} of the request. Orders you have already placed stay in the sales records, without the account attached to them.

**If you are unhappy with how we have handled this.** Write to {{contact_email}} and mark it for the grievance officer, or ring the shop on {{contact_phone}}. If we have not put it right, you may complain to the Data Protection Board of India.

**Changes to this page.** When we change it we change the page rather than emailing everyone; the date it was last updated is at the bottom.' WHERE slug = 'privacy';
