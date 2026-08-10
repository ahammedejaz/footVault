"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from "lucide-react";

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      /**
       * Pinned, not "system". This site has exactly one design — paper
       * surfaces, ink text — and no dark variant, so the toast must not follow
       * the customer's OS. It used to: `useTheme()` with no ThemeProvider
       * mounted falls back to "system", sonner stamped itself
       * `data-sonner-theme="dark"` on any phone in OS dark mode, and its own
       * stylesheet painted the *description* line near-white — while the
       * `--normal-bg` override below kept the background light paper. Title
       * readable, product name invisible. Add-to-bag was where it was noticed,
       * but every toast with a description had it.
       */
      theme="light"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
