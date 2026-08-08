"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { restoreProduct } from "@/lib/actions/admin/products";
import { toast } from "@/lib/toast";

/**
 * Undo a soft delete.
 *
 * Shared by the "Removed" filter on the list and the banner on a removed
 * product's own page, so the two cannot describe the same act differently — the
 * product comes back **off** the shop, and both places say so.
 */
export function RestoreButton({
  id,
  name,
  size = "sm",
}: {
  id: string;
  name: string;
  size?: "sm" | "default";
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  return (
    <Button
      variant="outline"
      size={size}
      disabled={pending}
      onClick={async () => {
        setPending(true);
        const result = await restoreProduct({ id });
        setPending(false);
        if (!result.ok) {
          toast.failed(result.message);
          return;
        }
        toast.done(
          `${name} is back`,
          "It stays off the shop until you turn it on.",
        );
        router.refresh();
      }}
    >
      {pending ? "Working…" : "Put it back"}
    </Button>
  );
}
