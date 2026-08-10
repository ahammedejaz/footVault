import { RowListSkeleton } from "@/components/storefront/skeletons";

export default function Loading() {
  return (
    <RowListSkeleton
      heading="w-48"
      maxWidth="max-w-4xl"
      rows={4}
      label="Loading your orders"
    />
  );
}
