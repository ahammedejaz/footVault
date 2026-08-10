"use client";

import * as React from "react";
import { Pause, Play } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The hero's moving layer, over a still that is already on screen.
 *
 * ## The one rule this component exists to keep
 *
 * **The video is never the Largest Contentful Paint element, and never competes
 * with it for bandwidth.** The poster is a real `<img>` in the server-rendered
 * markup, `priority`, and it is what the customer sees at first paint. This
 * component renders no `<video>` at all until the page has finished loading and
 * the browser has gone idle. Until then the hero is exactly the hero that
 * shipped before videos existed, and the network is spending every byte on the
 * thing being measured.
 *
 * That is also why the still lives outside this component rather than in the
 * `<video poster>` attribute. A poster image inside a `<video>` is an eligible
 * LCP candidate, so using the attribute would make the video element the thing
 * LCP reports — the exact outcome the rule forbids — and it would put the
 * shop's most important image behind a client component's hydration.
 *
 * ## Reduced motion is a different experience, not a lesser one
 *
 * A customer who has asked their device for less motion does not get a paused
 * video, a first frame, or a shorter one. They get the still, and this
 * component returns `null` before a single byte of video is requested. The
 * distinction is not pedantry: a paused `<video>` still downloads, so "show the
 * poster instead" implemented the usual way costs a person on a metered
 * connection megabytes for footage they have told the operating system they do
 * not want to see.
 *
 * `Save-Data` is honoured on the same line and for the same reason. Somebody
 * who has turned on data saver has asked a question this component can answer.
 *
 * ## Why the fade waits for `playing` and not `canplay`
 *
 * `canplay` means enough has buffered to start; `playing` means frames are
 * actually going up. Fading on the former shows a black rectangle for however
 * long the decode takes. Fading on the latter means the still is replaced only
 * once there is something to replace it with, and if playback never starts —
 * autoplay refused, codec unsupported, iOS in low power mode, the file gone —
 * the opacity simply stays at zero and the customer keeps the still.
 *
 * The fallback is structural rather than an error handler: nothing has to
 * *detect* failure, because the success path is the only thing that reveals the
 * video. There is no state in which both are wrong.
 *
 * ## The pause control is not optional
 *
 * WCAG 2.2 SC 2.2.2 applies to motion that starts automatically and runs for
 * more than five seconds. A ten-second loop is squarely inside it, and
 * `prefers-reduced-motion` does not discharge the requirement: it serves people
 * whose device is configured, not the person on a borrowed laptop who simply
 * wants the movement to stop. So there is a real button, it has a real
 * accessible name, and it has a 44px hit target.
 *
 * It is styled to be quiet rather than hidden. A control that appears on hover
 * is a control a touch user cannot find, and one that appears only on focus is
 * useless to the sighted mouse user who is feeling motion-sick.
 */
export function HeroVideo({ src }: { src: string }) {
  const [mounted, setMounted] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  const [paused, setPaused] = React.useState(false);
  const ref = React.useRef<HTMLVideoElement>(null);

  React.useEffect(() => {
    /*
      Both checks read the environment once, on mount, and never subscribe.
      A customer who changes their motion preference mid-visit is not a case
      worth a listener that has to tear a playing video down; the next
      navigation reads it again.
    */
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const connection = (
      navigator as Navigator & { connection?: { saveData?: boolean } }
    ).connection;
    if (connection?.saveData) return;

    let cancelled = false;
    let idle = 0;
    let timer = 0;

    /*
      After load, then after idle. `load` alone is not late enough — it fires
      while the browser is still settling images and fonts, which is exactly the
      window LCP is measured in. The 3s timeout is the floor: on a page that
      never goes idle the video should still eventually arrive, just last.
    */
    function schedule() {
      if (cancelled) return;
      const request = window.requestIdleCallback;
      if (typeof request === "function") {
        idle = request(
          () => {
            if (!cancelled) setMounted(true);
          },
          { timeout: 3_000 },
        );
      } else {
        timer = window.setTimeout(() => {
          if (!cancelled) setMounted(true);
        }, 1_200);
      }
    }

    if (document.readyState === "complete") {
      schedule();
    } else {
      window.addEventListener("load", schedule, { once: true });
    }

    return () => {
      cancelled = true;
      window.removeEventListener("load", schedule);
      if (idle && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idle);
      }
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  /*
    `autoPlay` covers almost every browser, and the explicit `play()` covers the
    rest by producing a promise whose rejection can be *observed*. Without it, a
    refused autoplay is silent and the button would sit there saying "Pause"
    over a still that is not playing.
  */
  React.useEffect(() => {
    if (!mounted) return;
    const video = ref.current;
    if (!video) return;
    void video.play().catch(() => setPaused(true));
  }, [mounted]);

  if (!mounted) return null;

  function toggle() {
    const video = ref.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => setPaused(true));
    else video.pause();
  }

  return (
    <>
      <video
        ref={ref}
        // Decorative: the hero's meaning is the heading and the copy beneath it,
        // both of which are real text. A screen reader announcing a silent
        // looping background film is announcing furniture.
        aria-hidden
        tabIndex={-1}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        onPlaying={() => {
          setReady(true);
          setPaused(false);
        }}
        onPause={() => setPaused(true)}
        onPlay={() => setPaused(false)}
        className={cn(
          "absolute inset-0 size-full object-cover",
          // Opacity only. The still underneath is the same frame at the same
          // size, so there is nothing to move — a scale or a slide here would
          // announce a change that has not happened. 700ms rather than the
          // 200ms a button gets: nobody pressed anything, and a fast fade on a
          // full-bleed image reads as a flicker rather than a transition.
          "transition-opacity duration-700 ease-[cubic-bezier(0.4,0,0.2,1)]",
          ready ? "opacity-100" : "opacity-0",
        )}
      >
        <source src={src} type={src.endsWith(".webm") ? "video/webm" : "video/mp4"} />
      </video>

      {/* Only once there is motion to stop. Before that it would be a control
          for something that is not happening. */}
      {ready ? (
        <button
          type="button"
          onClick={toggle}
          className={cn(
            /*
              `size-11` is 44px, and it is the real box rather than `hit-44`'s
              pseudo-element. `hit-44` sets `position: relative` on the element
              it is applied to, which silently beat `absolute` here and parked
              this button in the top-left corner of the hero — caught in a
              screenshot, not by any assertion. Two utilities that both own
              `position` cannot be combined, so this one owns its own size.
            */
            "absolute right-3 bottom-3 z-10 grid size-11 place-items-center rounded-full",
            "bg-ink/55 text-paper backdrop-blur-sm",
            "transition-[background-color,transform] duration-150 ease-out",
            "hover:bg-ink/75 active:scale-[0.94]",
            "focus-visible:ring-paper focus-visible:ring-2 focus-visible:ring-offset-0 focus-visible:outline-none",
          )}
        >
          {paused ? (
            <Play className="size-4 translate-x-px" aria-hidden />
          ) : (
            <Pause className="size-4" aria-hidden />
          )}
          <span className="sr-only">
            {paused ? "Play the background video" : "Pause the background video"}
          </span>
        </button>
      ) : null}
    </>
  );
}
