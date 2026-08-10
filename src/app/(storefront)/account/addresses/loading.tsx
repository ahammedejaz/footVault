import { RowListSkeleton } from "@/components/storefront/skeletons";

export default function Loading() {
  return (
    <RowListSkeleton
      heading="w-64"
      maxWidth="max-w-2xl"
      rows={3}
      label="Loading your addresses"
    />
  );
}
