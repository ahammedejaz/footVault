import { StorefrontChrome } from "@/components/storefront/chrome";

export default function StorefrontLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <StorefrontChrome>{children}</StorefrontChrome>;
}
