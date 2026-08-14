"use client";

import * as React from "react";

import {
  MAX_ADJUSTMENT,
  MAX_ROTATION,
  MAX_SIZE,
  MIN_SIZE,
  fillOf,
  type Crop,
} from "@/lib/images/crop";

/**
 * The square the photograph is framed inside.
 *
 * ## What this is, and what it is not
 *
 * It is **a viewer for six numbers**. It renders `crop` and reports changes to
 * it; it does not cut anything, and it never produces pixels. The asset is cut
 * server-side from the same six numbers by `normaliseProductImage`, which is
 * what makes a re-crop and a `PIPELINE_VERSION` rebuild possible a year from
 * now — and what makes this component replaceable without touching the output.
 *
 * The arithmetic lives in `@/lib/images/crop`, imported by both sides. If this
 * file computed its own rectangle, the owner would be approving a picture the
 * shop was not about to store, which is the one failure a cropping tool cannot
 * have.
 *
 * ## The frame moves, the square does not
 *
 * The brief is explicit and it is right: the square is fixed and the photograph
 * moves and scales inside it. There is no handle to drag, no aspect selector,
 * no way to produce a non-square result — that decision was made by the
 * pipeline and re-litigating it in the UI would only let the owner make a
 * mistake the shop then has to render.
 *
 * ## Touch first, because this is used standing up
 *
 * Drag with one finger, pinch with two, and on a desktop drag with the mouse
 * and scroll to zoom. Pointer Events give all of that from one set of handlers
 * — no separate touch path to fall out of sync — and pointer capture means a
 * drag that leaves the square keeps working rather than stopping dead at the
 * edge, which on a tablet is most drags.
 *
 * The sliders below are not a fallback for the gestures. They are the version
 * of this that works with a keyboard, that a screen reader can name, and that a
 * harness can operate by its visible label — and the rule in this codebase is
 * that a control which cannot be found by its label is a defect, not a testing
 * inconvenience.
 */

/** How far one arrow-key press moves the picture, as a fraction of the frame. */
const NUDGE = 0.01;

/** One wheel notch, as a proportion of the current zoom. */
const WHEEL_STEP = 0.0015;

export type Frame = { width: number; height: number };
export type Subject = { x: number; y: number; width: number; height: number };

export function CropStage({
  src,
  frame,
  crop,
  subject,
  targetFill,
  onChange,
  disabled,
}: {
  /** A blob URL for the staged file, or the stored original's public URL. */
  src: string;
  /** The photograph's dimensions, as the server measured them. */
  frame: Frame;
  crop: Crop;
  /** Where the shoe is, or null when auto-frame could not tell. */
  subject: Subject | null;
  /** The fraction the guide is drawn at, from the owner's settings. */
  targetFill: number;
  onChange: (next: Crop) => void;
  disabled?: boolean;
}) {
  const stageRef = React.useRef<HTMLDivElement>(null);
  /** Live pointers, by id, so two fingers can be told from one. */
  const pointers = React.useRef(new Map<number, { x: number; y: number }>());
  /** The pinch distance and crop size when the second finger landed. */
  const pinch = React.useRef<{ distance: number; size: number } | null>(null);

  /**
   * The frame, after straightening — the rectangle the crop's fractions are
   * fractions of.
   *
   * The analytic bounding box of a rotated rectangle, which is the same
   * calculation the browser does for a rotated element and the same one libvips
   * does server-side. The two can disagree by a pixel on the frame's edge,
   * which moves the crop by under a tenth of a percent; the server's own
   * measurement is authoritative and this is the preview.
   */
  const rotated = React.useMemo(() => {
    const radians = (Math.abs(crop.rotation) * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return {
      width: frame.width * cos + frame.height * sin,
      height: frame.width * sin + frame.height * cos,
    };
  }, [frame.width, frame.height, crop.rotation]);

  const fill = subject
    ? fillOf(subject, crop, rotated.width, rotated.height)
    : null;
  const belowTarget = fill !== null && fill < targetFill - 0.02;

  function move(dx: number, dy: number) {
    onChange({
      ...crop,
      cx: clamp01(crop.cx + dx),
      cy: clamp01(crop.cy + dy),
    });
  }

  function zoomTo(size: number) {
    onChange({ ...crop, size: clamp(size, MIN_SIZE, MAX_SIZE) });
  }

  /* ------------------------------------------------------- pointers ------ */

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (disabled) return;
    // Capture, so a drag that leaves the square keeps tracking. On a tablet
    // held in one hand, most drags leave the square.
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (pointers.current.size === 2) {
      pinch.current = { distance: spread(pointers.current), size: crop.size };
    }
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (disabled) return;
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;

    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return;

    if (pointers.current.size >= 2 && pinch.current) {
      const distance = spread(pointers.current);
      if (pinch.current.distance > 0) {
        // Pinching apart magnifies, which means a *smaller* crop square.
        zoomTo(pinch.current.size * (pinch.current.distance / distance));
      }
      return;
    }

    /**
     * A drag moves the picture, so the crop moves the other way — and it moves
     * by the fraction of the *crop square* the finger crossed, not the fraction
     * of the stage. Zoomed in, the same finger travel covers less photograph,
     * which is what makes a magnified drag feel precise rather than skittish.
     */
    const perPixel =
      (crop.size * Math.max(rotated.width, rotated.height)) / stage.width;
    move(
      (-(event.clientX - previous.x) * perPixel) / rotated.width,
      (-(event.clientY - previous.y) * perPixel) / rotated.height,
    );
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  }

  /* ------------------------------------------------------ rendering ------ */

  /**
   * Where the photograph sits so that the chosen square lands on the stage.
   *
   * Read right to left, which is the order the browser applies them: rotate
   * about the picture's own centre, shift by the distance from the frame's
   * centre to the crop's centre, then centre the whole thing in the stage. The
   * shift is in *unrotated* frame units because it is applied after the
   * rotation, which is exactly how the server extracts.
   */
  const longer = Math.max(rotated.width, rotated.height);

  /**
   * **A CSS translate percentage is a percentage of the element's own size**,
   * not of its container — and getting that wrong is invisible to every
   * assertion in the suite.
   *
   * The first version multiplied the offset by the render scale as though the
   * percentage were relative to the stage. The numbers came out an order of
   * magnitude too large, the photograph was translated clear out of the square,
   * and the panel sat there reporting "the shoe fills 85% of the frame" over an
   * empty fog rectangle. Every gate passed: the readout was right, the stored
   * asset was right, the crop was right. A screenshot caught it.
   *
   * The distance from the frame's centre to the crop's centre is
   * `(cx − 0.5) · frameWidth` in frame pixels; the element is `frameWidth` wide
   * in those same units, so as a fraction of itself that is just `cx − 0.5` —
   * scaled by how much the rotated bounding box exceeds the picture, since the
   * fractions are of the rotated frame and the element is the unrotated one.
   */
  const offsetX = (crop.cx - 0.5) * (rotated.width / frame.width) * 100;
  const offsetY = (crop.cy - 0.5) * (rotated.height / frame.height) * 100;

  return (
    <div className="space-y-3">
      <div
        ref={stageRef}
        tabIndex={disabled ? -1 : 0}
        role="group"
        aria-label="Framing — drag to move, pinch or scroll to zoom, arrow keys to nudge"
        aria-disabled={disabled || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={(event) => {
          if (disabled) return;
          zoomTo(crop.size * (1 + event.deltaY * WHEEL_STEP));
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          const step = event.shiftKey ? NUDGE * 4 : NUDGE;
          switch (event.key) {
            case "ArrowLeft":
              move(-step, 0);
              break;
            case "ArrowRight":
              move(step, 0);
              break;
            case "ArrowUp":
              move(0, -step);
              break;
            case "ArrowDown":
              move(0, step);
              break;
            case "+":
            case "=":
              zoomTo(crop.size * 0.95);
              break;
            case "-":
              zoomTo(crop.size / 0.95);
              break;
            default:
              return;
          }
          // Only once a key has actually been handled: swallowing every key
          // would take the page's own scrolling and shortcuts with it.
          event.preventDefault();
        }}
        className={[
          "bg-fog relative aspect-square w-full overflow-hidden rounded-lg",
          /*
            No `outline-hidden` here, and it must stay that way.

            This div is `tabIndex={0}` and is operated entirely from the
            keyboard — arrows nudge the crop, shift-arrows nudge it four times
            as far, +/- zoom. It carried `focus-visible:outline-hidden` and
            nothing in its place: no ring, no focus state, no background
            change. So a keyboard user could focus it, press an arrow, and see
            the photograph move with no indication of what they were driving.

            The exemptions in `focus-ring.ts` are for controls that indicate
            focus some other way — a menu item's `bg-accent` is a real
            indicator, just not an outline. This one had none, which is why it
            is fixed rather than allowlisted. `overflow-hidden` above clips the
            image, not the indicator: an outline is painted outside the border
            box and follows `rounded-lg`.
          */

          // `touch-none` is not decoration: without it the browser claims the
          // drag for page scrolling and the photograph twitches once and stops.
          "touch-none select-none",
          disabled ? "cursor-progress opacity-60" : "cursor-grab active:cursor-grabbing",
        ].join(" ")}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt=""
          draggable={false}
          className="absolute top-1/2 left-1/2 max-w-none origin-center"
          style={{
            width: `${(frame.width / longer) * (1 / crop.size) * 100}%`,
            transform: `translate(-50%, -50%) translate(${-offsetX}%, ${-offsetY}%) rotate(${crop.rotation}deg)`,
            filter: adjustmentFilter(crop),
          }}
        />

        {/*
          The fill guide: an inset square at the target, so "fill this much of
          the frame" is something the owner can see rather than a percentage
          they have to hold in their head and judge against.

          Drawn over the picture with a hairline rather than a heavy box —
          it is a reference, and a guide loud enough to compete with the shoe
          would be a guide the owner starts framing *to* instead of the product.
        */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 grid place-items-center"
        >
          <div
            className="rounded-xs border border-dashed transition-colors duration-150 ease-out"
            style={{
              width: `${targetFill * 100}%`,
              height: `${targetFill * 100}%`,
              borderColor: belowTarget
                ? "color-mix(in oklab, var(--fv-orange) 70%, transparent)"
                : "color-mix(in oklab, var(--fv-ink) 35%, transparent)",
            }}
          />
        </div>
      </div>

      {/*
        The readout says what it knows and admits what it does not. Three
        states, and the third is the one that matters: roughly a third of real
        photographs defeat the detector, and "couldn't find the shoe" invites a
        correction where a confident wrong number would simply be believed.
      */}
      <p
        className="text-sm"
        aria-live="polite"
        data-testid="fill-readout"
      >
        {fill === null ? (
          <span className="text-muted-foreground">
            Couldn&rsquo;t find the shoe against that background — centred
            instead. Drag and zoom until it sits inside the dashed square.
          </span>
        ) : (
          <>
            <span className="font-medium tabular-nums">
              The shoe fills {Math.round(fill * 100)}% of the frame
            </span>{" "}
            {belowTarget ? (
              <span className="text-muted-foreground">
                — the shop aims for {Math.round(targetFill * 100)}%. Zoom in
                until it reaches the dashed square.
              </span>
            ) : (
              <span className="text-muted-foreground">
                — that matches the rest of the catalogue.
              </span>
            )}
          </>
        )}
      </p>
    </div>
  );
}

/**
 * Brightness and contrast, previewed in CSS.
 *
 * An honest approximation rather than a promise. The server applies
 * `modulate` and a linear ramp pivoting on mid-grey; the browser's filter
 * functions are close but not identical, so the tone here is indicative while
 * the *framing* — the thing this component exists for — is exact. Colour
 * accuracy is decided by the conservative ranges on the sliders, not by
 * matching two filter implementations to the level.
 */
function adjustmentFilter(crop: Crop): string | undefined {
  if (crop.brightness === 0 && crop.contrast === 0) return undefined;
  const brightness = 1 + crop.brightness / (MAX_ADJUSTMENT * 2.5);
  const contrast = 1 + crop.contrast / (MAX_ADJUSTMENT * 2.5);
  return `brightness(${brightness}) contrast(${contrast})`;
}

function spread(pointers: Map<number, { x: number; y: number }>): number {
  const [first, second] = [...pointers.values()];
  if (!first || !second) return 0;
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** The straighten, zoom and tone controls — labelled, so they can be found. */
export function CropControls({
  crop,
  onChange,
  disabled,
}: {
  crop: Crop;
  onChange: (next: Crop) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {/*
        Zoom is stated as magnification rather than as `size`, because the
        stored number runs backwards from how anyone thinks about it: a smaller
        crop square is a bigger shoe. The slider shows what the owner is doing,
        and the conversion happens here, once.
      */}
      <Slider
        id="crop-zoom"
        label="Zoom"
        value={Number((1 / crop.size).toFixed(2))}
        min={Number((1 / MAX_SIZE).toFixed(2))}
        max={Number((1 / MIN_SIZE).toFixed(2))}
        step={0.01}
        suffix="×"
        disabled={disabled}
        onChange={(next) =>
          onChange({ ...crop, size: clamp(1 / next, MIN_SIZE, MAX_SIZE) })
        }
      />
      <Slider
        id="crop-straighten"
        label="Straighten"
        value={crop.rotation}
        min={-MAX_ROTATION}
        max={MAX_ROTATION}
        step={0.5}
        suffix="°"
        disabled={disabled}
        onChange={(next) => onChange({ ...crop, rotation: next })}
      />
      <Slider
        id="crop-brightness"
        label="Brightness"
        value={crop.brightness}
        min={-MAX_ADJUSTMENT}
        max={MAX_ADJUSTMENT}
        step={1}
        disabled={disabled}
        onChange={(next) => onChange({ ...crop, brightness: next })}
      />
      <Slider
        id="crop-contrast"
        label="Contrast"
        value={crop.contrast}
        min={-MAX_ADJUSTMENT}
        max={MAX_ADJUSTMENT}
        step={1}
        disabled={disabled}
        onChange={(next) => onChange({ ...crop, contrast: next })}
      />
    </div>
  );
}

function Slider({
  id,
  label,
  value,
  min,
  max,
  step,
  suffix,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1 flex items-baseline justify-between text-sm font-medium"
      >
        <span>{label}</span>
        <span className="text-muted-foreground tabular-nums">
          {value}
          {suffix ?? ""}
        </span>
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        /*
          `accent-orange`, not `accent-fv-orange`: the theme maps the brand
          tokens as `--color-orange` in globals.css, so the utility is named for
          the mapped colour. The wrong name silently produces no class at all
          and the slider renders in the browser's default blue — which is not a
          colour in this design system, and which a screenshot at 390 is how you
          find out.

          h-11 because 44px is the smallest reliable touch target, and a bare
          range input is about half that.
        */
        className="accent-orange h-11 w-full"
        onChange={(event) => onChange(event.target.valueAsNumber)}
      />
    </div>
  );
}
