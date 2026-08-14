/**
 * The shop on Google Maps, so a customer can navigate to the counter.
 *
 * ## The two things that make this more than an iframe
 *
 * **It only renders because the CSP lets it.** The shop's policy is in enforce
 * mode, and `frame-src` is the directive that decides whether a browser is even
 * allowed to ask for this frame. Dropped into the page without the matching
 * entry in `src/lib/csp.ts`, this is not a degraded map — it is an empty box and
 * a console error, and it looks exactly like a Google outage.
 *
 * **It is a disclosure.** Loading this page now sends the visitor's IP address
 * and browser to Google whether or not they touch the map, and it happens on
 * page load rather than on a click. That makes Google a processor for everybody
 * who opens `/page/contact`, not only for the customers who choose "Continue
 * with Google" — so the privacy page says so, `src/lib/processors.ts` declares
 * the host, and `npm run audit:privacy` fails if either stops being true.
 *
 * ## The URL
 *
 * Opaque on purpose: `pb=` is Google's own encoding of the place, the zoom and
 * the viewport, and it is not editable by hand. Regenerate it from Google Maps →
 * the listing → Share → Embed a map, and paste the `src` here. It points at the
 * "Foot vault branded store" listing, which is also what the Google Business
 * Profile work in Batch K will attach to.
 */
export const SHOP_MAP_EMBED =
  "https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d61735.230793421586!2d78.4890118041722!3d14.743550496778509!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x3bb3870050254933%3A0xbd250527b3d6edb!2sFoot%20vault%20branded%20store!5e0!3m2!1sen!2sin!4v1786712602016!5m2!1sen!2sin";

export function ShopMap() {
  return (
    <iframe
      src={SHOP_MAP_EMBED}
      /*
        Named rather than left to the URL. A screen reader announces an untitled
        frame as "frame", and the one thing a person navigating to a shop needs
        to know is which frame is the map.
      */
      title="Map showing the Foot Vault shop"
      loading="lazy"
      referrerPolicy="strict-origin-when-cross-origin"
      allowFullScreen
      /*
        A fixed height rather than an aspect ratio, and `w-full` rather than the
        600px the embed code ships with: 600px is wider than every phone the
        overflow gate measures. The height is reserved before the frame loads, so
        a lazy map costs no layout shift.
      */
      className="h-64 w-full rounded-lg border-0 sm:h-80"
    />
  );
}
