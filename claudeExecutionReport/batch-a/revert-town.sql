-- Restores the town wording written 2026-08-14.

UPDATE site_settings SET value = jsonb_set(value, '{address}', to_jsonb('Classic Vastralayam Complex, Shop No. 2, Near RTC Bus Stand, Cuddapah, Andhra Pradesh 516360'::text)) WHERE key = 'contact';

UPDATE pages SET body = 'Foot Vault is a footwear shop in Kadapa — still widely written Cuddapah — in Andhra Pradesh. There is a real shop with real shelves, near the RTC bus stand, and this website sells from the same stock.

That last part is the whole point of it, so it is worth saying plainly rather than leaving it to be assumed. Nothing here is drop-shipped and nothing is ordered in after you buy it. When your order arrives with us, somebody walks to a shelf, takes the box down, opens it, checks the pair inside and packs it.

**The size counts are real.** If a product page says one pair is left in your size, there is one pair on the shelf. A size shown as sold out is genuinely gone — we do not hide sizes to make a run look fuller than it is, and we would rather show you an honest gap than a full grid you cannot buy from.

**What we stock.** Sneakers, formal shoes, boots, sports shoes and sandals, for men, women and kids. The brands are the ones people come in and ask for by name — at the moment Nike, adidas, Puma, ASICS, New Balance, Skechers, Campus, Bata, Metro, Red Chief, Woodland and Crocs. It is a narrower range than a marketplace carries, deliberately: everything on the site is something we would put in front of somebody across the counter.

**What we do not do, said here rather than in the small print.** We do not offer refunds, and we cannot exchange for a different size. If a pair arrives damaged we replace it, and there is a short window to tell us. The returns page explains it properly, and it is worth two minutes before you buy rather than after — a policy you only discover afterwards is a policy designed to catch you out, and this one is not.

**If something is wrong.** One message sorts it out. Ring the shop or send a WhatsApp; the number and our opening hours are on the contact page. You will get somebody who can walk to the shelf and look.

Come and see us if you are nearby. Trying a pair on is still the best way to buy shoes, and we would rather you did that than guess.', meta_description = 'Foot Vault is a footwear shop in Kadapa (Cuddapah), Andhra Pradesh. The same shelves that serve the counter serve this website.' WHERE slug = 'about';

UPDATE pages SET body = 'The quickest way to reach us is WhatsApp, on {{contact_whatsapp}}. We answer during shop hours, usually within the hour. If you would rather talk, ring the shop on {{contact_phone}} — it is the same people at the same counter.

Prefer email? Write to {{contact_email}}. Replying to any email we have sent you about an order lands in the same inbox, so you can simply hit reply.

For an order that already exists, send the order number — it looks like FV-2026-00147 — and we can pull it up straight away.

**If a parcel has arrived damaged, ring or send a WhatsApp message rather than emailing.** That claim closes {{return_window}} after delivery, and an email may not be read in time. The returns page lists what to send us.

**Where we are.** {{contact_address}}. Kadapa and Cuddapah are the same city — both spellings are in everyday use here, and the post arrives under either.

**When we are open.** {{business_hours}}.

You are welcome to come in and try a pair on. There is nothing to book and no appointment to make: come to the counter and ask. Trying shoes on is still the best way to buy them, and somebody who can walk to the shelf will be standing in front of you.', meta_description = 'Phone, WhatsApp, email and the address of the Foot Vault shop in Kadapa (Cuddapah), Andhra Pradesh, with our opening hours.' WHERE slug = 'contact';

UPDATE pages SET body = 'We ship across India from our shop in Kadapa (Cuddapah), Andhra Pradesh.

Orders placed before {{dispatch_cutoff}} are handed to the courier the same day. Anything later goes with the next day''s collection.

How long the journey then takes depends on where it is going, and we would rather show you the real figure than an average. Enter your pin code on any product page and we will give you the dates for your own address, taken from the courier that will actually be carrying the parcel. Checkout shows them again before you pay.

**Paying online** — delivery is free on orders of {{free_shipping_threshold}} or more. Below that you pay what the courier charges to reach your pin code. The exact figure appears as soon as you enter your pin code, never added at the last step.

**Pay on Delivery** — you pay {{delivery_advance}} online when you place the order, and the rest in cash to the courier when it arrives. Your order is not placed until that first payment goes through.

The amount you pay now covers delivery, and it is taken off what the courier collects — so you pay the same either way. Checkout shows all three figures before you pay: what you pay now, what the courier will collect, and the total.

Pay on Delivery is offered on orders of {{cod_minimum_order_value}} and above. Below that, paying online is the only option, because the delivery charge would be most of the order.

Not every courier will collect cash at every pin code. If yours is one they will not, the option is not offered and you can pay online instead — the order still comes to the same address. A very small number of pin codes have no courier service from us at all, and checkout will say so before you pay rather than take an order we cannot deliver.', meta_description = 'What delivery costs, when your order leaves our shop in Kadapa, and how Pay on Delivery works. Free delivery over {{free_shipping_threshold}}.' WHERE slug = 'shipping';
