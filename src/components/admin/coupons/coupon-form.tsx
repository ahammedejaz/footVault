"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { FieldLabel } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  createCoupon,
  findCustomersForCoupon,
  setCouponCustomers,
  updateCoupon,
} from "@/lib/actions/admin/coupons";
import { toast } from "@/lib/toast";

/**
 * Adding and editing a coupon — the three controls the owner asked for by
 * name (on/off, a scheduled window, specific customers) plus the limits.
 *
 * **Dates are typed and shown in IST.** `starts_at`/`expires_at` are stored
 * as UTC instants; a `datetime-local` value entered here is interpreted as
 * Asia/Kolkata and converted on the way out, and converted back on the way
 * in. IST has no daylight saving, so the offset is the constant +05:30 —
 * a coupon typed as "starts today at 09:00" that silently meant UTC would
 * start five and a half hours late, which for a festival sale is the whole
 * morning.
 *
 * **Money is typed in rupees and stored in paise.** The two `Math.round`s on
 * the way out are the entire conversion; the action refuses non-integers so
 * a bug here fails loudly rather than pricing a discount at a hundredth.
 */

export type CouponDraft = {
  id: string;
  code: string;
  type: "percent" | "fixed";
  value: number;
  minOrderValue: number;
  maxDiscount: number | null;
  usageLimit: number | null;
  perUserLimit: number | null;
  audience: "everyone" | "specific_customers";
  startsAt: string | null;
  expiresAt: string | null;
  isActive: boolean;
};

export type AudienceMember = {
  userId: string;
  name: string | null;
  email: string | null;
};

const IST_OFFSET = "+05:30";

/** A UTC instant as the IST wall-clock string `datetime-local` wants. */
function toISTLocal(iso: string | null): string {
  if (!iso) return "";
  const utc = new Date(iso);
  if (Number.isNaN(utc.getTime())) return "";
  // en-CA gives yyyy-mm-dd; the time is formatted 24h and reassembled.
  const date = utc.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const time = utc.toLocaleTimeString("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${date}T${time}`;
}

/** The IST wall-clock string back to a UTC instant. */
function fromISTLocal(value: string): string | null {
  if (!value) return null;
  const instant = new Date(`${value}:00${IST_OFFSET}`);
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

export function CouponForm({
  coupon,
  audience,
  triggerLabel,
  triggerVariant = "outline",
  triggerSize = "sm",
}: {
  /** Absent when adding. */
  coupon?: CouponDraft;
  /** The current audience list, when editing a specific-customers code. */
  audience?: AudienceMember[];
  triggerLabel: React.ReactNode;
  triggerVariant?: "default" | "outline" | "ghost" | "secondary";
  triggerSize?: "sm" | "default" | "icon-sm";
}) {
  const router = useRouter();
  const editing = coupon !== undefined;

  const [open, setOpen] = React.useState(false);
  const [code, setCode] = React.useState(coupon?.code ?? "");
  const [type, setType] = React.useState<"percent" | "fixed">(
    coupon?.type ?? "percent",
  );
  const [value, setValue] = React.useState(
    coupon
      ? String(coupon.type === "percent" ? coupon.value : coupon.value / 100)
      : "",
  );
  const [minOrder, setMinOrder] = React.useState(
    coupon && coupon.minOrderValue > 0 ? String(coupon.minOrderValue / 100) : "",
  );
  const [maxDiscount, setMaxDiscount] = React.useState(
    coupon?.maxDiscount ? String(coupon.maxDiscount / 100) : "",
  );
  const [usageLimit, setUsageLimit] = React.useState(
    coupon?.usageLimit ? String(coupon.usageLimit) : "",
  );
  const [perUserLimit, setPerUserLimit] = React.useState(
    coupon?.perUserLimit ? String(coupon.perUserLimit) : "",
  );
  const [audienceKind, setAudienceKind] = React.useState<
    "everyone" | "specific_customers"
  >(coupon?.audience ?? "everyone");
  const [members, setMembers] = React.useState<AudienceMember[]>(
    audience ?? [],
  );
  const [startsAt, setStartsAt] = React.useState(
    toISTLocal(coupon?.startsAt ?? null),
  );
  const [expiresAt, setExpiresAt] = React.useState(
    toISTLocal(coupon?.expiresAt ?? null),
  );
  const [isActive, setIsActive] = React.useState(coupon?.isActive ?? true);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // The picker.
  const [search, setSearch] = React.useState("");
  const [searching, setSearching] = React.useState(false);
  const [found, setFound] = React.useState<AudienceMember[]>([]);

  const fieldId = React.useId();

  function reset() {
    setCode(coupon?.code ?? "");
    setType(coupon?.type ?? "percent");
    setValue(
      coupon
        ? String(coupon.type === "percent" ? coupon.value : coupon.value / 100)
        : "",
    );
    setMinOrder(
      coupon && coupon.minOrderValue > 0
        ? String(coupon.minOrderValue / 100)
        : "",
    );
    setMaxDiscount(coupon?.maxDiscount ? String(coupon.maxDiscount / 100) : "");
    setUsageLimit(coupon?.usageLimit ? String(coupon.usageLimit) : "");
    setPerUserLimit(coupon?.perUserLimit ? String(coupon.perUserLimit) : "");
    setAudienceKind(coupon?.audience ?? "everyone");
    setMembers(audience ?? []);
    setStartsAt(toISTLocal(coupon?.startsAt ?? null));
    setExpiresAt(toISTLocal(coupon?.expiresAt ?? null));
    setIsActive(coupon?.isActive ?? true);
    setSearch("");
    setFound([]);
    setError(null);
  }

  async function runSearch() {
    if (search.trim().length < 2) return;
    setSearching(true);
    const result = await findCustomersForCoupon({ q: search });
    setSearching(false);
    if (result.ok) setFound(result.customers);
    else setError(result.message);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const numeric = Number(value);
    const payload = {
      code,
      type,
      value:
        type === "percent" ? Math.round(numeric) : Math.round(numeric * 100),
      minOrderPaise: minOrder ? Math.round(Number(minOrder) * 100) : 0,
      maxDiscountPaise: maxDiscount
        ? Math.round(Number(maxDiscount) * 100)
        : null,
      usageLimit: usageLimit ? Math.round(Number(usageLimit)) : null,
      perUserLimit: perUserLimit ? Math.round(Number(perUserLimit)) : null,
      audience: audienceKind,
      startsAt: fromISTLocal(startsAt),
      expiresAt: fromISTLocal(expiresAt),
      isActive,
    };

    const result = editing
      ? await updateCoupon({ ...payload, id: coupon.id })
      : await createCoupon(payload);

    if (!result.ok) {
      setPending(false);
      setError(result.message);
      return;
    }

    // The audience travels with the save: a specific-customers code with an
    // empty list refuses everyone, which the owner is told rather than left
    // to discover.
    if (audienceKind === "specific_customers" || editing) {
      const audienceResult = await setCouponCustomers({
        couponId: result.id,
        userIds:
          audienceKind === "specific_customers"
            ? members.map((member) => member.userId)
            : [],
      });
      if (!audienceResult.ok) {
        setPending(false);
        setError(audienceResult.message);
        return;
      }
    }

    setPending(false);
    setOpen(false);
    if (!editing) reset();
    toast.done(
      editing ? `${payload.code} saved` : `${payload.code} created`,
      audienceKind === "specific_customers" && members.length === 0
        ? "It is aimed at specific customers but the list is empty, so nobody can use it yet."
        : undefined,
    );
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        reset();
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant={triggerVariant} size={triggerSize}>
          {triggerLabel}
        </Button>
      </DialogTrigger>

      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-pretty">
            {editing ? `Edit ${coupon.code}` : "Add a coupon"}
          </DialogTitle>
          <DialogDescription className="text-pretty">
            The customer types the code in their bag. Every rule below is
            enforced again at the moment the order is placed.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel htmlFor={`${fieldId}-code`} required>
                Code
              </FieldLabel>
              <Input
                id={`${fieldId}-code`}
                value={code}
                onChange={(event) =>
                  setCode(event.target.value.toUpperCase())
                }
                placeholder="FOOTVAULT10"
                maxLength={40}
                required
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                disabled={pending}
              />
            </div>
            <div>
              <FieldLabel htmlFor={`${fieldId}-type`} required>
                Kind
              </FieldLabel>
              <select
                id={`${fieldId}-type`}
                value={type}
                onChange={(event) =>
                  setType(event.target.value as "percent" | "fixed")
                }
                disabled={pending}
                className="border-input bg-background h-11 w-full rounded-sm border px-3 text-sm"
              >
                <option value="percent">Percent off the goods</option>
                <option value="fixed">Fixed amount off</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel htmlFor={`${fieldId}-value`} required>
                {type === "percent" ? "Percent off" : "Amount off, in ₹"}
              </FieldLabel>
              <Input
                id={`${fieldId}-value`}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={type === "percent" ? "10" : "500"}
                inputMode="numeric"
                required
                autoComplete="off"
                disabled={pending}
              />
            </div>
            <div>
              <FieldLabel
                htmlFor={`${fieldId}-max`}
                hint={
                  type === "percent"
                    ? "A ceiling in ₹, so 10% of an expensive pair stays sane. Optional."
                    : "Rarely needed on a fixed amount. Optional."
                }
              >
                Maximum discount, in ₹
              </FieldLabel>
              <Input
                id={`${fieldId}-max`}
                value={maxDiscount}
                onChange={(event) => setMaxDiscount(event.target.value)}
                placeholder="1000"
                inputMode="numeric"
                autoComplete="off"
                disabled={pending}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <FieldLabel
                htmlFor={`${fieldId}-min`}
                hint="Goods only — delivery never counts towards it."
              >
                Minimum order, in ₹
              </FieldLabel>
              <Input
                id={`${fieldId}-min`}
                value={minOrder}
                onChange={(event) => setMinOrder(event.target.value)}
                placeholder="0"
                inputMode="numeric"
                autoComplete="off"
                disabled={pending}
              />
            </div>
            <div>
              <FieldLabel
                htmlFor={`${fieldId}-limit`}
                hint="Across the whole shop. Empty = unlimited."
              >
                Total uses
              </FieldLabel>
              <Input
                id={`${fieldId}-limit`}
                value={usageLimit}
                onChange={(event) => setUsageLimit(event.target.value)}
                placeholder="100"
                inputMode="numeric"
                autoComplete="off"
                disabled={pending}
              />
            </div>
            <div>
              <FieldLabel
                htmlFor={`${fieldId}-per-user`}
                hint="Per signed-in customer. Empty = unlimited."
              >
                Uses per customer
              </FieldLabel>
              <Input
                id={`${fieldId}-per-user`}
                value={perUserLimit}
                onChange={(event) => setPerUserLimit(event.target.value)}
                placeholder="1"
                inputMode="numeric"
                autoComplete="off"
                disabled={pending}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel
                htmlFor={`${fieldId}-starts`}
                hint="Indian time. Empty = usable straight away."
              >
                Starts
              </FieldLabel>
              <Input
                id={`${fieldId}-starts`}
                type="datetime-local"
                value={startsAt}
                onChange={(event) => setStartsAt(event.target.value)}
                autoComplete="off"
                disabled={pending}
              />
            </div>
            <div>
              <FieldLabel
                htmlFor={`${fieldId}-expires`}
                hint="Indian time. Empty = never expires."
              >
                Ends
              </FieldLabel>
              <Input
                id={`${fieldId}-expires`}
                type="datetime-local"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
                autoComplete="off"
                disabled={pending}
              />
            </div>
          </div>

          <div>
            <FieldLabel htmlFor={`${fieldId}-audience`}>Who can use it</FieldLabel>
            <select
              id={`${fieldId}-audience`}
              value={audienceKind}
              onChange={(event) =>
                setAudienceKind(
                  event.target.value as "everyone" | "specific_customers",
                )
              }
              disabled={pending}
              className="border-input bg-background h-11 w-full rounded-sm border px-3 text-sm"
            >
              <option value="everyone">Everyone</option>
              <option value="specific_customers">Specific customers only</option>
            </select>
          </div>

          {audienceKind === "specific_customers" ? (
            <div className="border-border space-y-2 rounded-sm border p-3">
              <p className="text-muted-foreground text-xs text-pretty">
                Only the people below can use this code. Everyone else is told
                the code did not work — not that it exists and is not for them.
              </p>
              {members.length ? (
                <ul className="space-y-1">
                  {members.map((member) => (
                    <li
                      key={member.userId}
                      className="flex items-center justify-between gap-2 text-sm"
                    >
                      <span className="truncate">
                        {member.name ?? "Unnamed customer"}
                        {member.email ? (
                          <span className="text-muted-foreground">
                            {" "}
                            · {member.email}
                          </span>
                        ) : null}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          setMembers((current) =>
                            current.filter(
                              (candidate) =>
                                candidate.userId !== member.userId,
                            ),
                          )
                        }
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-destructive text-xs">
                  Nobody yet — the code will refuse everyone until someone is
                  added.
                </p>
              )}
              <div className="flex gap-2">
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void runSearch();
                    }
                  }}
                  placeholder="Search name, phone or email"
                  autoComplete="off"
                  disabled={pending}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={runSearch}
                  disabled={pending || searching || search.trim().length < 2}
                >
                  {searching ? "Searching…" : "Search"}
                </Button>
              </div>
              {found.length ? (
                <ul className="space-y-1">
                  {found
                    .filter(
                      (candidate) =>
                        !members.some(
                          (member) => member.userId === candidate.userId,
                        ),
                    )
                    .map((candidate) => (
                      <li
                        key={candidate.userId}
                        className="flex items-center justify-between gap-2 text-sm"
                      >
                        <span className="truncate">
                          {candidate.name ?? "Unnamed customer"}
                          {candidate.email ? (
                            <span className="text-muted-foreground">
                              {" "}
                              · {candidate.email}
                            </span>
                          ) : null}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={() =>
                            setMembers((current) => [...current, candidate])
                          }
                        >
                          Add
                        </Button>
                      </li>
                    ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <label className="flex min-h-11 items-center gap-2.5">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(event) => setIsActive(event.target.checked)}
              disabled={pending}
              className="accent-foreground size-5"
            />
            <span className="text-sm">
              Switched on
              <span className="text-muted-foreground block text-xs">
                Off, the code is refused exactly as if it never existed. The
                schedule above still applies when it is on.
              </span>
            </span>
          </label>

          {error ? (
            <p className="text-destructive text-sm text-pretty" role="alert">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={pending || !code.trim() || !value.trim()}
            >
              {pending ? "Saving…" : editing ? "Save" : "Add it"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
