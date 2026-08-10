import { RowListSkeleton } from "@/components/storefront/skeletons";

export default function Loading() {
  return (
    <RowListSkeleton
      heading="w-56"
      maxWidth="max-w-2xl"
      rows={2}
      rowHeight="h-28"
      label="Loading your account"
    />
  );
}
