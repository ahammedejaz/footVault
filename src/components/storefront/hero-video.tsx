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
          /*
            No transition. This used to fade in over 700ms, and the fade was
            wrong for a reason that only became true once the poster was a real
            frame of this file.

            `playing` fires with the video at frame zero, and the still
            underneath *is* frame zero. A 700ms fade therefore cross-dissolves a
            static frame zero against a video that is already moving — for
            those 700ms the hero shows two shoes in two places at partial
            opacity, which is a ghost. Swapping instantly shows frame zero
            replaced by frame zero (or by frame one, 41ms of ordinary motion at
            24fps), and there is nothing to see.

            The reveal still hangs off `playing` rather than `loadeddata`, so
            the structural fallback is untouched: the success path is the only
            thing that reveals the video, and a clip that never starts leaves
            the still exactly where it was.

            This makes "the poster is a frame of this video" load-bearing. It
            already was — the field's own hint says so — but a fade used to
            soften a mismatched poster, and now nothing does.
          */
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
              The *target* is 44px and did not change. Only the paint did.

              `size-11` is 44px, and it is the real box rather than `hit-44`'s
              pseudo-element. `hit-44` sets `position: relative` on the element
              it is applied to, which silently beat `absolute` here and parked
              this button in the top-left corner of the hero — caught in a
              screenshot, not by any assertion. Two utilities that both own
              `position` cannot be combined, so this one owns its own size.

              Keeping 44 rather than dropping to SC 2.5.8's 24px minimum: the
              project's own floor is 44 (`.tap-target`, `hit-44`), a touch user
              has no hover to reveal anything, and shrinking a target is not
              what "quieter" was asked for — the button carries no paint of its
              own now, so 44px costs nothing visually.

              No `outline-none`. That utility is what `audit:focus-ring` exists
              to catch: it sits in `@layer utilities`, beats the composite
              indicator `@layer base` defines, and deletes the orange half of it
              site-wide for the component that used it. The previous version of
              this button had it. The global indicator is also the "comes
              forward on keyboard focus" half of the brief, at full strength.
            */
            "group absolute right-3 bottom-3 z-10 grid size-11 place-items-center",
            "rounded-full active:scale-[0.94]",
          )}
        >
          {/*
            The visible mark, and it is deliberately almost nothing.

            32px inside the 44px target, ink at 70% with the icon at 60% paper.
            Measured against this clip's corner — which never rises above luma
            54/255 across the whole loop — the disc reads 1.16:1 against the
            footage behind it, so as a *shape* it is invisible; what a person
            sees is a dim glyph.

            70/60 rather than something quieter still, because the split has to
            survive a clip that does not exist yet. SC 1.4.11 wants 3:1 for the
            visual information identifying a control, and the icon-against-disc
            ratio is what has to hold:

              this clip's corner   6.77:1
              its brightest pixel  5.96:1
              a mid-bright clip    5.03:1
              a pure white clip    3.57:1

            A more opaque disc is the lever that buys the last row, and it costs
            nothing in quietness because ink over a dark corner is still dark.
            Thinning the icon instead would have failed the moment somebody
            uploaded daylight footage.
          */}
          <span
            className={cn(
              "grid size-8 place-items-center rounded-full",
              "bg-ink/70 text-paper/60 backdrop-blur-[2px]",
              "transition-[background-color,color] duration-200 ease-out",
              "group-hover:bg-ink/85 group-hover:text-paper",
              "group-focus-visible:bg-ink/85 group-focus-visible:text-paper",
            )}
          >
            {paused ? (
              <Play className="size-3.5 translate-x-px" aria-hidden />
            ) : (
              <Pause className="size-3.5" aria-hidden />
            )}
          </span>
          <span className="sr-only">
            {paused ? "Play the background video" : "Pause the background video"}
          </span>
        </button>
      ) : null}
    </>
  );
}
