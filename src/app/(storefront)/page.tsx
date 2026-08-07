import { HomeSection } from "@/components/storefront/home-sections";
import { getHomepageSections } from "@/lib/queries/content";

/**
 * The homepage renders whatever is in `homepage_sections`, in that order.
 *
 * Nothing about the composition lives here: reordering the rows from
 * /admin/appearance in Phase 7 reorders the live page. The `revalidate` below
 * is the floor — publishing from the admin will call revalidatePath so a change
 * is live immediately rather than within the hour.
 */
export const revalidate = 3600;

export default async function HomePage() {
  const sections = await getHomepageSections();

  if (sections.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-24 text-center sm:px-6">
        <h1 className="font-display text-2xl font-bold tracking-[-0.02em] uppercase">
          The homepage is empty
        </h1>
        <p className="text-muted-foreground mt-3 text-base">
          No sections are published yet. Add one from the appearance settings,
          or run <code className="font-mono text-sm">npm run seed</code> to load
          the starting layout.
        </p>
      </div>
    );
  }

  return (
    <>
      {sections.map((section) => (
        <HomeSection key={section.id} section={section} />
      ))}
    </>
  );
}
