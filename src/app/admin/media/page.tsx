import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { FolderOpen } from "lucide-react";

import { MediaItemActions } from "@/components/admin/media/media-item-actions";
import { MediaUploader } from "@/components/admin/media/media-uploader";
import { SearchField } from "@/components/admin/search-field";
import {
  Pagination,
  SortableTh,
  Table,
  TableWrap,
  Td,
  Th,
} from "@/components/admin/table";
import { AdminPage, Chip, EmptyState, PageHeader } from "@/components/admin/ui";
import {
  listHref,
  parseListParams,
  type SearchParams,
} from "@/lib/admin/list-params";
import {
  ALLOWED_IMAGE_TYPES,
  formatBytes,
  listMedia,
  MAX_UPLOAD_BYTES,
  MEDIA_SORTS,
  PRODUCT_IMAGE_BUCKET,
  type MediaSort,
} from "@/lib/queries/admin/media";

export const metadata: Metadata = { title: "Media" };
export const dynamic = "force-dynamic";

/** A folder path from the URL, kept to what this screen is allowed to open. */
function safePrefix(value: string): string {
  if (!value) return "";
  if (value.includes("..")) return "";
  return /^[a-z0-9][a-z0-9/-]*$/.test(value) ? value : "";
}

/**
 * The product photograph library.
 *
 * A table rather than a gallery of tiles, and the thumbnail is a column in it.
 * The questions the owner comes here with are "which of these is the big one",
 * "what is this file called so I can paste it", and "is anything using it" —
 * all three are comparisons down a column, which is the thing a grid of squares
 * is worst at. It also means this screen sorts and pages like every other list
 * in the panel instead of inventing its own controls.
 *
 * The bucket is `product-images`, created in
 * `supabase/migrations/…_storage.sql`. It is public-read by design — these are
 * photographs on an open storefront and signing each URL would cost a round
 * trip per thumbnail — and admin-only for writes, enforced by RLS on
 * `storage.objects` rather than by this page.
 */
export default async function AdminMediaPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const params = parseListParams<MediaSort>(sp, {
    sortable: MEDIA_SORTS,
    defaultSort: "created_at",
    defaultDir: "desc",
    perPage: 24,
  });

  const prefix = safePrefix(typeof sp.prefix === "string" ? sp.prefix : "");
  const extras = { prefix: prefix || undefined };

  const { items, folders, total, capped, unusedCount } = await listMedia(
    params,
    prefix,
  );

  return (
    <>
      <PageHeader
        title="Media"
        description={`Photographs in the ${PRODUCT_IMAGE_BUCKET} store. Upload here, then paste an address onto a product or a brand.`}
      />

      <AdminPage className="space-y-4">
        <MediaUploader
          prefix={prefix}
          maxBytes={MAX_UPLOAD_BYTES}
          acceptTypes={ALLOWED_IMAGE_TYPES}
        />

        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            label="Search photographs"
            placeholder="File name"
            hidden={extras}
          />
        </div>

        {prefix ? (
          <nav
            aria-label="Folder"
            className="flex flex-wrap items-center gap-2"
          >
            <Link
              href="/admin/media"
              className="hover:text-foreground text-muted-foreground inline-flex min-h-9 items-center text-sm underline-offset-4 hover:underline"
            >
              All photographs
            </Link>
            <span className="text-muted-foreground text-sm" aria-hidden>
              /
            </span>
            <span className="font-mono text-sm">{prefix}</span>
          </nav>
        ) : null}

        {capped ? (
          <p className="border-border text-muted-foreground rounded-md border border-dashed px-3 py-2 text-sm text-pretty">
            This folder holds more files than this screen reads at once, so some
            are not listed. Move older photographs into a folder to keep this
            usable.
          </p>
        ) : null}

        {folders.length > 0 ? (
          <nav aria-label="Folders" className="flex flex-wrap gap-2">
            {folders.map((folder) => (
              <Link
                key={folder.prefix}
                href={listHref(
                  "/admin/media",
                  params,
                  { page: 1 },
                  { prefix: folder.prefix },
                )}
                className="border-border hover:border-foreground/40 inline-flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm transition-colors"
              >
                <FolderOpen className="size-4 shrink-0" aria-hidden />
                {folder.name}
              </Link>
            ))}
          </nav>
        ) : null}

        {items.length === 0 ? (
          <EmptyState
            title={params.q ? "No file matches that" : "No photographs yet"}
            body={
              params.q
                ? "File names are made from the name the picture had when it was uploaded. Try a shorter search."
                : "Use the field above to upload the first ones. Product photographs live here, and every product page reads them from this store."
            }
            actionHref={
              params.q
                ? listHref(
                    "/admin/media",
                    params,
                    { page: 1, q: "" },
                    { prefix: prefix || undefined },
                  )
                : "/admin/products"
            }
            actionLabel={params.q ? "Show every photograph" : "See products"}
          />
        ) : (
          <>
            <TableWrap label="Photographs">
              <Table className="min-w-[52rem]">
                <thead>
                  <tr>
                    <Th className="w-20">Preview</Th>
                    <SortableTh
                      column="name"
                      params={params}
                      basePath="/admin/media"
                      extras={extras}
                    >
                      File
                    </SortableTh>
                    <SortableTh
                      column="size"
                      params={params}
                      basePath="/admin/media"
                      extras={extras}
                      numeric
                      initialDir="desc"
                    >
                      Size
                    </SortableTh>
                    <SortableTh
                      column="created_at"
                      params={params}
                      basePath="/admin/media"
                      extras={extras}
                      initialDir="desc"
                    >
                      Uploaded
                    </SortableTh>
                    <Th>Used by</Th>
                    <Th className="text-right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.path} className="hover:bg-muted/40">
                      <Td>
                        <a
                          href={item.publicUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="border-border block size-14 overflow-hidden rounded-sm border"
                        >
                          <Image
                            src={item.publicUrl}
                            alt={`${item.fileName}, full size in a new tab`}
                            width={56}
                            height={56}
                            className="size-14 object-cover"
                          />
                        </a>
                      </Td>
                      <Td className="max-w-[18rem]">
                        <span className="block truncate font-mono text-xs">
                          {item.fileName}
                        </span>
                        <span className="text-muted-foreground block truncate text-xs">
                          {item.mimeType ?? "unknown type"}
                        </span>
                      </Td>
                      <Td numeric className="whitespace-nowrap">
                        {formatBytes(item.sizeBytes)}
                      </Td>
                      <Td className="text-muted-foreground whitespace-nowrap">
                        {item.createdAt ? formatDate(item.createdAt) : "—"}
                      </Td>
                      <Td className="max-w-[16rem]">
                        {item.usedBy.length === 0 ? (
                          <Chip tone="neutral">unused</Chip>
                        ) : (
                          <div className="flex flex-col gap-0.5">
                            {item.usedBy.slice(0, 2).map((use) => (
                              <Link
                                key={`${use.productId}-${use.imageRowId}`}
                                href={`/admin/products/${use.productId}`}
                                className="block truncate text-sm underline-offset-4 hover:underline"
                              >
                                {use.productName}
                                {use.isPrimary ? (
                                  <span className="text-muted-foreground">
                                    {" "}
                                    · main
                                  </span>
                                ) : null}
                              </Link>
                            ))}
                            {item.usedBy.length > 2 ? (
                              <span className="text-muted-foreground text-xs">
                                and {item.usedBy.length - 2} more
                              </span>
                            ) : null}
                          </div>
                        )}
                      </Td>
                      <Td className="pr-1">
                        <MediaItemActions
                          path={item.path}
                          fileName={item.fileName}
                          publicUrl={item.publicUrl}
                          usedBy={item.usedBy}
                        />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>

            <Pagination
              params={params}
              total={total}
              basePath="/admin/media"
              extras={extras}
            />

            <p className="text-muted-foreground text-sm text-pretty">
              {unusedCount === 0
                ? "Every photograph here is on a product."
                : `${unusedCount} of these ${unusedCount === 1 ? "is" : "are"} not on any product.`}{" "}
              A file is matched to a product by the address stored against it,
              so one added outside this panel with a different address will show
              as unused.
            </p>
          </>
        )}
      </AdminPage>
    </>
  );
}

/** Short, shop-local, and never the raw ISO string. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}
