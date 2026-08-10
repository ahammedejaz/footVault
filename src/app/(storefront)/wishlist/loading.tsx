import { RowListSkeleton } from "@/components/storefront/skeletons";

export default function Loading() {
  return (
    <RowListSkeleton
      heading="w-52"
      maxWidth="max-w-3xl"
      rows={3}
      rowHeight="h-28"
      label="Loading your saved items"
    />
  );
}
