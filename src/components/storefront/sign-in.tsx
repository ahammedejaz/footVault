"use client";

import { useActionState } from "react";

import { GoogleMark } from "@/components/brand/google-mark";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCurrentPath } from "@/hooks/use-current-path";
import { signInWithGoogle, SIGN_IN_IDLE } from "@/lib/actions/auth";

/**
 * The only way in.
 *
 * A real `<form>` around a Server Action, so it works with JavaScript off and
 * so a failure has somewhere to land — a button wired to an onClick would
 * report a provider outage to the console and look, to the customer, like
 * nothing happened.
 *
 * `next` is filled from the live location rather than baked at render, so the
 * customer comes back to the page they were reading and not to the homepage.
 */
export function GoogleSignInForm({
  label = "Continue with Google",
  className,
  next,
}: {
  label?: string;
  className?: string;
  /** Overrides the current location — used when the destination is not here. */
  next?: string;
}) {
  const [state, formAction, pending] = useActionState(signInWithGoogle, SIGN_IN_IDLE);
  const here = useCurrentPath();

  return (
    <form action={formAction} className={className}>
      <input type="hidden" name="next" value={next ?? here} readOnly />
      <Button type="submit" size="lg" variant="outline" className="w-full" disabled={pending}>
        <GoogleMark className="size-4" />
        {pending ? "Opening Google…" : label}
      </Button>
      {state.error ? (
        <p role="alert" className="text-state-low mt-3 text-sm text-pretty">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/**
 * The contextual prompt.
 *
 * Shown when somebody reaches for something that needs an account — saving a
 * shoe, opening the order history. The reason is passed in and stated plainly,
 * because "Sign in to continue" does not tell anyone why this time is
 * different, and the answer ("so it is still there on your next phone") is the
 * actual argument for having an account at all.
 *
 * Never in front of buying. Checkout stays open to guests.
 */
export function SignInDialog({
  open,
  onOpenChange,
  title = "Sign in to save it",
  reason,
  next,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  reason: string;
  next?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-100">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl font-bold tracking-[-0.02em] uppercase">
            {title}
          </DialogTitle>
          <DialogDescription className="text-base text-pretty">{reason}</DialogDescription>
        </DialogHeader>
        <GoogleSignInForm next={next} />
        <p className="text-muted-foreground font-mono text-xs tracking-[0.06em]">
          You never need an account to buy.
        </p>
      </DialogContent>
    </Dialog>
  );
}
