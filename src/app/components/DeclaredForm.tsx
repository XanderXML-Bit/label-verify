"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { DeclaredFields } from "@/lib/types";

interface DeclaredFormProps {
  readonly onSubmit: (values: DeclaredFields) => void;
  readonly disabled?: boolean;
  readonly initial?: Partial<DeclaredFields>;
  /**
   * Optional callback for the "Skip — just show what's on the label"
   * affordance. When provided, the form renders a secondary button next
   * to "Verify" that submits to /api/extract instead. The label-only
   * flow doesn't require any of the fields to be filled in.
   */
  readonly onExtractOnly?: () => void;
}

export function DeclaredForm({
  onSubmit,
  disabled,
  initial,
  onExtractOnly,
}: DeclaredFormProps) {
  // Stable, unique ids per field so the wrapping <label> can use
  // htmlFor — needed so screen readers tie the visual label to its input
  // even when the input is two children deep.
  const ids = {
    brand: useId(),
    classType: useId(),
    classCategory: useId(),
    abv: useId(),
    ncValue: useId(),
    ncUnit: useId(),
    producer: useId(),
    country: useId(),
  };
  const [brand, setBrand] = useState(initial?.brand_name ?? "");
  const [classType, setClassType] = useState(initial?.class_type ?? "");
  const [classCategory, setClassCategory] = useState<
    DeclaredFields["class_category"]
  >(initial?.class_category ?? "beer");
  const [abv, setAbv] = useState<string>(
    initial?.abv_percent != null ? String(initial.abv_percent) : "",
  );
  const [ncValue, setNcValue] = useState<string>(
    initial?.net_contents?.value != null
      ? String(initial.net_contents.value)
      : "",
  );
  const [ncUnit, setNcUnit] = useState<"fl_oz" | "ml" | "L" | "cl">(
    initial?.net_contents?.unit ?? "fl_oz",
  );
  const [producer, setProducer] = useState<string>(
    typeof initial?.producer === "string"
      ? initial.producer
      : initial?.producer?.name ?? "",
  );
  const [country, setCountry] = useState(initial?.country_of_origin ?? "USA");

  // Per-field "user has interacted with this control" flags. Needed for the
  // three fields whose default is a non-empty value (classCategory="beer",
  // ncUnit="fl_oz", country="USA"). For text fields a "" check is enough —
  // if the user typed and cleared it, the most charitable read is they
  // want a fresh prefill. But for select/non-empty defaults we cannot
  // distinguish "the form just rendered with the default" from "the user
  // explicitly chose this option that happens to be the default". A late
  // prefill that disagrees with their choice would silently overwrite it,
  // which is what the UI audit caught. Sticky `touched` flags fix that:
  // once the user clicks the control we never overwrite, regardless of
  // current value. (Text fields use empty-string check via `!brand`, etc.)
  const [touched, setTouched] = useState<{
    classCategory: boolean;
    ncUnit: boolean;
    country: boolean;
  }>({ classCategory: false, ncUnit: false, country: false });

  // When `initial` updates AFTER the form has mounted (e.g. a background
  // application parse lands while the user is on the single-pending
  // screen), merge it in WITHOUT clobbering anything the user has
  // already touched. Rule: per field, if the user hasn't interacted with
  // it AND the new prefill has a value, apply it; otherwise leave the
  // user's input alone. Late-arriving prefill can populate a fresh form
  // but won't steamroller an explicit choice (UI audit fix).
  useEffect(() => {
    if (!initial) return;
    if (!brand && initial.brand_name) setBrand(initial.brand_name);
    if (!classType && initial.class_type) setClassType(initial.class_type);
    if (!touched.classCategory && initial.class_category) {
      setClassCategory(initial.class_category);
    }
    if (!abv && initial.abv_percent != null) setAbv(String(initial.abv_percent));
    if (!ncValue && initial.net_contents?.value != null) {
      setNcValue(String(initial.net_contents.value));
    }
    if (!touched.ncUnit && initial.net_contents?.unit) {
      setNcUnit(initial.net_contents.unit);
    }
    if (!producer) {
      const incoming =
        typeof initial.producer === "string"
          ? initial.producer
          : initial.producer?.name;
      if (incoming) setProducer(incoming);
    }
    if (!touched.country && initial.country_of_origin) {
      setCountry(initial.country_of_origin);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  const [errors, setErrors] = useState<string[]>([]);
  // Per-field error keys so each input can render aria-invalid + an
  // adjacent message. Mirrors `errors` for the summary block but lets
  // a screen reader (or a sighted senior reviewer) jump directly to
  // the offending input.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const errorBlockRef = useRef<HTMLDivElement | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: string[] = [];
    const fieldErrs: Record<string, string> = {};
    if (!brand) {
      errs.push("Brand name is required.");
      fieldErrs.brand = "Brand name is required.";
    }
    if (!classType) {
      errs.push("Class / type is required.");
      fieldErrs.classType = "Class / type is required.";
    }
    const abvN = Number(abv);
    if (!Number.isFinite(abvN) || abvN < 0 || abvN > 100) {
      errs.push("ABV must be a number between 0 and 100.");
      fieldErrs.abv = "ABV must be a number between 0 and 100.";
    }
    const ncN = Number(ncValue);
    if (!Number.isFinite(ncN) || ncN <= 0) {
      errs.push("Net contents value must be a positive number.");
      fieldErrs.ncValue = "Must be a positive number.";
    }
    if (!country) {
      errs.push("Country of origin is required.");
      fieldErrs.country = "Country of origin is required.";
    }
    if (errs.length) {
      setErrors(errs);
      setFieldErrors(fieldErrs);
      // Scroll + focus the error summary so a senior reviewer who clicks
      // Verify and sees nothing happen above the fold is brought to the
      // problem instead of guessing. aria-live="assertive" already
      // announces to screen readers; this covers sighted users. We
      // feature-detect scrollIntoView so jsdom-based unit tests don't
      // throw on the missing API.
      requestAnimationFrame(() => {
        const el = errorBlockRef.current;
        if (el?.scrollIntoView) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        el?.focus?.();
      });
      return;
    }
    setErrors([]);
    setFieldErrors({});
    onSubmit({
      brand_name: brand,
      class_type: classType,
      class_category: classCategory,
      abv_percent: abvN,
      net_contents: { value: ncN, unit: ncUnit },
      producer: producer || "",
      country_of_origin: country,
    });
  }

  const inputClass =
    "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500 dark:focus:border-blue-400 dark:focus:ring-blue-400 dark:disabled:bg-slate-900";

  return (
    <form onSubmit={submit} aria-label="Declared application data" className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
        Application data
      </h2>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Enter the field values declared on the COLA application. The label
        image will be compared against these.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id={ids.brand} label="Brand name" required error={fieldErrors.brand}>
          <input
            id={ids.brand}
            name="brand_name"
            type="text"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            disabled={disabled}
            autoComplete="off"
            aria-invalid={!!fieldErrors.brand}
            aria-describedby={fieldErrors.brand ? `${ids.brand}-err` : undefined}
            className={inputClass}
          />
        </Field>
        <Field
          id={ids.classType}
          label="Class / type"
          required
          error={fieldErrors.classType}
        >
          <input
            id={ids.classType}
            name="class_type"
            type="text"
            value={classType}
            onChange={(e) => setClassType(e.target.value)}
            disabled={disabled}
            autoComplete="off"
            placeholder="e.g. India Pale Ale"
            aria-invalid={!!fieldErrors.classType}
            aria-describedby={
              fieldErrors.classType ? `${ids.classType}-err` : undefined
            }
            className={inputClass}
          />
        </Field>
        <Field id={ids.classCategory} label="Category" required>
          <select
            id={ids.classCategory}
            name="class_category"
            value={classCategory}
            onChange={(e) => {
              setClassCategory(e.target.value as DeclaredFields["class_category"]);
              setTouched((t) => ({ ...t, classCategory: true }));
            }}
            disabled={disabled}
            className={inputClass}
          >
            <option value="beer">Beer / Malt Beverage</option>
            <option value="wine">Wine</option>
            <option value="distilled_spirits">Distilled Spirits</option>
            <option value="fortified_wine">Fortified Wine</option>
          </select>
        </Field>
        <Field id={ids.abv} label="ABV (%)" required error={fieldErrors.abv}>
          <input
            id={ids.abv}
            name="abv_percent"
            type="number"
            step="0.1"
            min="0"
            max="100"
            inputMode="decimal"
            value={abv}
            onChange={(e) => setAbv(e.target.value)}
            disabled={disabled}
            aria-invalid={!!fieldErrors.abv}
            aria-describedby={fieldErrors.abv ? `${ids.abv}-err` : undefined}
            className={inputClass}
          />
        </Field>
        <Field
          id={ids.ncValue}
          label="Net contents value"
          required
          error={fieldErrors.ncValue}
        >
          <input
            id={ids.ncValue}
            name="net_contents_value"
            type="number"
            step="0.1"
            min="0"
            inputMode="decimal"
            value={ncValue}
            onChange={(e) => setNcValue(e.target.value)}
            disabled={disabled}
            aria-invalid={!!fieldErrors.ncValue}
            aria-describedby={
              fieldErrors.ncValue ? `${ids.ncValue}-err` : undefined
            }
            className={inputClass}
          />
        </Field>
        <Field id={ids.ncUnit} label="Net contents unit" required>
          <select
            id={ids.ncUnit}
            name="net_contents_unit"
            value={ncUnit}
            onChange={(e) => {
              setNcUnit(e.target.value as "fl_oz" | "ml" | "L" | "cl");
              setTouched((t) => ({ ...t, ncUnit: true }));
            }}
            disabled={disabled}
            className={inputClass}
          >
            <option value="fl_oz">fl oz</option>
            <option value="ml">ml</option>
            <option value="cl">cl</option>
            <option value="L">L</option>
          </select>
        </Field>
        <Field id={ids.producer} label="Producer / address">
          <textarea
            id={ids.producer}
            name="producer"
            value={producer}
            onChange={(e) => setProducer(e.target.value)}
            disabled={disabled}
            rows={2}
            className={inputClass}
          />
        </Field>
        <Field
          id={ids.country}
          label="Country of origin"
          required
          error={fieldErrors.country}
        >
          <input
            id={ids.country}
            name="country_of_origin"
            type="text"
            value={country}
            onChange={(e) => {
              setCountry(e.target.value);
              setTouched((t) => ({ ...t, country: true }));
            }}
            disabled={disabled}
            autoComplete="country-name"
            aria-invalid={!!fieldErrors.country}
            aria-describedby={
              fieldErrors.country ? `${ids.country}-err` : undefined
            }
            className={inputClass}
          />
        </Field>
      </div>

      {errors.length > 0 && (
        <div
          ref={errorBlockRef}
          tabIndex={-1}
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 outline-none ring-blue-500 focus:ring-2 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
        >
          <h3 className="font-semibold">Fix these before continuing</h3>
          <ul className="mt-1 list-inside list-disc">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={disabled}
          className="min-h-[44px] rounded-md bg-blue-600 px-6 py-2.5 text-base font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-blue-500 dark:hover:bg-blue-400"
        >
          Verify
        </button>
        {onExtractOnly && (
          // Secondary button — same control affordance as Verify, lower
          // visual weight (outlined, not filled) so a senior reviewer
          // can't fat-finger past Verify into the extract-only path,
          // but obvious enough that someone without application data
          // sees it as a button rather than as an inline text link.
          // Per user feedback 2026-05-12.
          <button
            type="button"
            onClick={onExtractOnly}
            disabled={disabled}
            title="Run the extractor without a verdict — useful when you don't have the COLA application data."
            className="min-h-[44px] rounded-md border border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Skip — extract fields without a verdict
          </button>
        )}
      </div>
      {onExtractOnly && (
        // Helper text under the row of buttons. Explicit that
        // "Skip" is only for the case where no application data
        // exists — defends against an accidental click.
        <p className="text-xs text-slate-500 dark:text-slate-400">
          The skip button is for cases where you don&apos;t have COLA
          application data on hand. It returns extracted label fields
          and a Government-Warning subscore but no pass / fail /
          review verdict.
        </p>
      )}
    </form>
  );
}

function Field({
  id,
  label,
  children,
  required,
  error,
}: {
  readonly id: string;
  readonly label: string;
  readonly children: React.ReactNode;
  readonly required?: boolean;
  readonly error?: string;
}) {
  return (
    <label htmlFor={id} className="block">
      <span className="mb-1 block text-label font-medium text-slate-700 dark:text-slate-200">
        {label}
        {required && (
          <span className="ml-0.5 text-red-500 dark:text-red-400" aria-label="required">
            *
          </span>
        )}
      </span>
      {children}
      {error && (
        <span
          id={`${id}-err`}
          className="mt-1 block text-xs text-red-700 dark:text-red-300"
        >
          {error}
        </span>
      )}
    </label>
  );
}
