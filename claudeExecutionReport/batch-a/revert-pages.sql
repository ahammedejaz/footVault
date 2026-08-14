-- Foot Vault — Batch A revert
--
-- The exact `pages` rows as they stood on production immediately before Batch A,
-- generated with quote_literal() so the text is restored byte for byte. Run any
-- one of these to put a single page back; run all six to undo the batch.
--
-- Captured 2026-08-14, before the first write.

update public.pages set title = 'About Foot Vault', meta_title = null, meta_description = 'An independent footwear shop stocking sneakers, formal shoes, boots and sandals for men, women and kids.', body = 'Foot Vault is an independent footwear shop. We stock sneakers, formal shoes, boots, sports shoes and sandals for men, women and kids, from brands people actually ask for.

We hold every size we list. If a size shows as sold out on a product page, it is genuinely out of stock — we do not hide sizes to make a size run look fuller than it is.

Orders are packed and dispatched from our own shelves, not a drop-shipper''s. If something is wrong with what arrives, one message sorts it out.' where slug = 'about';

update public.pages set title = 'Contact us', meta_title = null, meta_description = 'Phone, WhatsApp and email for Foot Vault, plus our shop address and opening hours.', body = 'The fastest way to reach us is WhatsApp — we answer during shop hours and usually within the hour.

Prefer email? Write to inquiry@footvault.in. Replying to any email we have sent you about an order lands in the same inbox, so you can simply hit reply.

For an existing order, send your order number (it looks like FV-2026-00147) and we can pull it up straight away.

Our contact details and opening hours are in the footer of every page, and they are kept current from the shop''s own settings.' where slug = 'contact';

update public.pages set title = 'Privacy policy', meta_title = null, meta_description = 'What data Foot Vault collects, why, and how to have it removed.', body = 'We collect what an order needs and nothing else: your name, delivery address, phone number and email.

We use it to pack and deliver your order, to contact you about that order, and to show you your order history when you sign in. We do not sell it, and we do not share it with anyone other than the courier carrying your parcel.

Your bag is stored against a token in your browser until you sign in, at which point it moves to your account.

To have your account and its data deleted, contact us and we will remove it within 7 days. Orders already placed are kept as long as the law requires us to keep sales records.' where slug = 'privacy';

update public.pages set title = 'Terms of sale', meta_title = null, meta_description = 'The terms that apply when you buy from Foot Vault.', body = 'Prices are in Indian rupees and include all taxes. The price you see in your bag is the price you pay.

An order is confirmed when we accept it, not when it is placed. If an item sells out between your order and our packing it, we will tell you which item and refund that line in full.

Stock counts on this site are live. Where a product page says only two are left in your size, that is the real number on our shelf.

Nothing here affects your statutory rights.' where slug = 'terms';

update public.pages set title = 'Returns and damage', meta_title = null, meta_description = 'Foot Vault''s 7 day free return and size exchange policy.', body = 'Please read this before you buy. Our policy is narrower than most online shops and we would rather you know that now than discover it later.

**We do not offer refunds.** Not on change of mind, not on size, not on colour. Once an order is placed it is yours.

**We do not take returns online.** There is no returns button in your account and no pickup will be arranged. Everything below happens by contacting the store directly.

**If a pair arrives damaged, we will replace it.** That is the one thing we cover, and it comes with a hard deadline:

- Contact us **within 24 hours of the parcel being delivered**. After that we cannot help, because we can no longer tell damage in transit from damage in use.
- Call or WhatsApp the store on the number on our contact page, or email inquiry@footvault.in. With only 24 hours, call or WhatsApp first rather than waiting on an email reply.
- Keep the box, the packaging and the courier label. Send us photographs of the damage and of the packaging it arrived in — the courier will not accept a claim without them.
- Do not wear the pair. A sole that has been outside cannot be assessed or replaced.

If we agree the pair was damaged in transit, we send a replacement of the same item in the same size, subject to us holding it. If we do not hold it, we will agree something with you directly.

**Sizes.** We cannot exchange for a different size, so please use the size guide on every product page before ordering, and ask us if you are unsure. We would much rather answer a question than turn down a request afterwards.

**Pay on Delivery.** The amount you pay online when you place the order covers delivery both ways. If you cancel before we have handed the parcel to the courier, it comes back to you in full. Once it is on the road it is not refundable, because it pays the courier to carry the parcel to you and again to carry it back if it is refused.

**If we get it wrong** — the wrong shoe, the wrong size, or damage that happened before it left us — you get everything back, with nothing deducted. That is not the same as a change of mind, and we do not treat it as one.

Nothing on this page affects your statutory rights under Indian consumer law.' where slug = 'returns';

update public.pages set title = 'Shipping', meta_title = null, meta_description = 'Delivery times, shipping charges and free shipping threshold for Foot Vault orders.', body = 'We ship across India from our store in Cuddapah, Andhra Pradesh.

Orders placed before 4pm on a working day are dispatched the same day. Most addresses receive in 3–5 working days; remote pin codes can take longer.

**Paying online** — delivery is free on orders of {{free_shipping_threshold}} or more. Below that you pay what the courier charges to reach your pin code. The exact figure appears as soon as you enter your pin code, never added at the last step.

**Pay on Delivery** — you pay {{delivery_advance}} online when you place the order, and the rest in cash to the courier when it arrives. Your order is not placed until that first payment goes through.

The amount you pay now covers delivery, and it is taken off what the courier collects — so you pay the same either way. Checkout shows all three figures before you pay: what you pay now, what the courier will collect, and the total.

Pay on Delivery is offered on orders of {{cod_minimum_order_value}} and above. Below that, paying online is the only option, because the delivery charge would be most of the order.

Not every courier will collect cash at every pin code. If yours is one they will not, the option is not offered and you can pay online instead — the order still comes to the same address. A very small number of pin codes have no courier service from us at all, and checkout will say so before you pay rather than take an order we cannot deliver.' where slug = 'shipping';
