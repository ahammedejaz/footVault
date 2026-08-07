/** The shape both navigations render. Serialisable, so it crosses the boundary. */
export type NavItem = {
  label: string;
  href: string;
  description?: string | null;
  children?: NavItem[];
};
