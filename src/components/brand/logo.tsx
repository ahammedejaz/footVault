import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The Foot Vault mark: an outsole tread, rebuilt as flat vector from the
 * supplied logo. `currentColor` throughout, so it inherits the surface — brass
 * on navy in the footer, navy on paper in the header, single-colour at favicon
 * size.
 *
 * The mask id is derived from React's useId so several marks can coexist on a
 * page without colliding.
 */
function TreadMark({
  detail = "full",
  className,
  ...props
}: React.ComponentProps<"svg"> & { detail?: "full" | "simple" }) {
  const maskId = `fv-tread-${React.useId().replace(/:/g, "")}`;

  /**
   * Below roughly 40px the three toe sipes and the twin waist bars fall under a
   * pixel each and smear into a solid blob. The simple variant drops to two
   * thicker sipes and one waist bar, so the tread still reads as a tread in the
   * header, the footer and the favicon.
   */
  const isSimple = detail === "simple";

  return (
    <svg
      viewBox="0 0 64 128"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={cn("block", className)}
      {...props}
    >
      <mask
        id={maskId}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="64"
        height="128"
      >
        <path
          d="M32 4C46 4 57 14 57 30c0 14-5 26-10 36-4 8-5 14-4 22 2 12 1 24-7 31-3 3-5 3-8 0-8-7-9-19-7-31 1-8 0-14-4-22C12 56 7 44 7 30 7 14 18 4 32 4Z"
          fill="#fff"
        />
        {isSimple ? (
          <>
            <rect x="14" y="12" width="36" height="5" rx="2.5" fill="#000" />
            <rect x="13" y="22" width="38" height="5" rx="2.5" fill="#000" />
            <circle cx="32" cy="45" r="11" stroke="#000" strokeWidth="5" />
            <circle cx="32" cy="45" r="4" fill="#000" />
            <rect x="21" y="63" width="22" height="5" rx="2.5" fill="#000" />
            <circle cx="32" cy="98" r="9" stroke="#000" strokeWidth="5" />
            <circle cx="32" cy="98" r="3.5" fill="#000" />
          </>
        ) : (
          <>
            <rect x="16" y="10" width="32" height="3.4" rx="1.7" fill="#000" />
            <rect x="14" y="17" width="36" height="3.4" rx="1.7" fill="#000" />
            <rect x="13" y="24" width="38" height="3.4" rx="1.7" fill="#000" />
            <circle cx="32" cy="43" r="10" stroke="#000" strokeWidth="3.4" />
            <circle cx="32" cy="43" r="3.4" fill="#000" />
            <rect x="21" y="60" width="22" height="3.2" rx="1.6" fill="#000" />
            <rect x="22" y="67" width="20" height="3.2" rx="1.6" fill="#000" />
            <circle cx="32" cy="98" r="8" stroke="#000" strokeWidth="3.2" />
            <circle cx="32" cy="98" r="2.8" fill="#000" />
            <rect x="24" y="112" width="16" height="3.2" rx="1.6" fill="#000" />
          </>
        )}
      </mask>
      <rect
        width="64"
        height="128"
        fill="currentColor"
        mask={`url(#${maskId})`}
      />
    </svg>
  );
}

/**
 * The horizontal lockup: mark + wordmark set in the display face. The wordmark
 * is live text rather than an image so it stays crisp at every size, respects
 * the user's font settings, and reads to a screen reader without alt text.
 */
function Logo({
  className,
  showTagline = false,
  ...props
}: React.ComponentProps<"span"> & { showTagline?: boolean }) {
  return (
    <span
      className={cn("inline-flex items-center gap-2.5", className)}
      {...props}
    >
      <TreadMark detail="simple" className="text-orange h-9 w-[1.125rem]" />
      <span className="flex flex-col leading-none">
        <span className="font-display text-lg font-extrabold tracking-[-0.02em] whitespace-nowrap uppercase">
          Foot Vault
        </span>
        {showTagline ? (
          <span className="text-muted-foreground mt-1 font-mono text-xs tracking-[0.06em]">
            Every step counts
          </span>
        ) : null}
      </span>
    </span>
  );
}

export { Logo, TreadMark };
