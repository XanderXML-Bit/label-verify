"use client";

import { useId, useState } from "react";
import type { DeclaredFields } from "@/lib/types";

interface DeclaredFormProps {
  readonly onSubmit: (values: DeclaredFields) => void;
  readonly disabled?: boolean;
  readonly initial?: Partial<DeclaredFields>;
}

export function DeclaredForm({
  onSubmit,
  disabled,
  initial,
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
  const [errors, setErrors] = useState<string[]>([]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: string[] = [];
    if (!brand) errs.push("Brand name is required.");
    if (!classType) errs.push("Class / type is required.");
    const abvN = Number(abv);
    if (!Number.isFinite(abvN) || abvN < 0 || abvN > 100)
      errs.push("ABV must be a number between 0 and 100.");
    const ncN = Number(ncValue);
    if (!Number.isFinite(ncN) || ncN <= 0)
      errs.push("Net contents value must be a positive number.");
    if (!country) errs.push("Country of origin is required.");
    if (errs.length) {
      setErrors(errs);
      return;
    }
    setErrors([]);
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
    "w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-slate-50";

  return (
    <form onSubmit={submit} aria-label="Declared application data" className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-800">
        Application data
      </h2>
      <p className="text-sm text-slate-500">
        Enter the field values declared on the COLA application. The label
        image will be compared against these.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id={ids.brand} label="Brand name" required>
          <input
            id={ids.brand}
            type="text"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            disabled={disabled}
            autoComplete="off"
            className={inputClass}
          />
        </Field>
        <Field id={ids.classType} label="Class / type" required>
          <input
            id={ids.classType}
            type="text"
            value={classType}
            onChange={(e) => setClassType(e.target.value)}
            disabled={disabled}
            autoComplete="off"
            placeholder="e.g. India Pale Ale"
            className={inputClass}
          />
        </Field>
        <Field id={ids.classCategory} label="Category" required>
          <select
            id={ids.classCategory}
            value={classCategory}
            onChange={(e) =>
              setClassCategory(e.target.value as DeclaredFields["class_category"])
            }
            disabled={disabled}
            className={inputClass}
          >
            <option value="beer">Beer / Malt Beverage</option>
            <option value="wine">Wine</option>
            <option value="distilled_spirits">Distilled Spirits</option>
            <option value="fortified_wine">Fortified Wine</option>
          </select>
        </Field>
        <Field id={ids.abv} label="ABV (%)" required>
          <input
            id={ids.abv}
            type="number"
            step="0.1"
            min="0"
            max="100"
            inputMode="decimal"
            value={abv}
            onChange={(e) => setAbv(e.target.value)}
            disabled={disabled}
            className={inputClass}
          />
        </Field>
        <Field id={ids.ncValue} label="Net contents value" required>
          <input
            id={ids.ncValue}
            type="number"
            step="0.1"
            min="0"
            inputMode="decimal"
            value={ncValue}
            onChange={(e) => setNcValue(e.target.value)}
            disabled={disabled}
            className={inputClass}
          />
        </Field>
        <Field id={ids.ncUnit} label="Net contents unit" required>
          <select
            id={ids.ncUnit}
            value={ncUnit}
            onChange={(e) =>
              setNcUnit(e.target.value as "fl_oz" | "ml" | "L" | "cl")
            }
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
            value={producer}
            onChange={(e) => setProducer(e.target.value)}
            disabled={disabled}
            rows={2}
            className={inputClass}
          />
        </Field>
        <Field id={ids.country} label="Country of origin" required>
          <input
            id={ids.country}
            type="text"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            disabled={disabled}
            autoComplete="country-name"
            className={inputClass}
          />
        </Field>
      </div>

      {errors.length > 0 && (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800"
        >
          <h3 className="font-semibold">Fix these before continuing</h3>
          <ul className="mt-1 list-inside list-disc">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <button
        type="submit"
        disabled={disabled}
        className="min-h-[44px] w-full rounded-md bg-blue-600 px-6 py-2.5 text-base font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
      >
        Verify
      </button>
    </form>
  );
}

function Field({
  id,
  label,
  children,
  required,
}: {
  readonly id: string;
  readonly label: string;
  readonly children: React.ReactNode;
  readonly required?: boolean;
}) {
  return (
    <label htmlFor={id} className="block">
      <span className="mb-1 block text-label font-medium text-slate-700">
        {label}
        {required && (
          <span className="ml-0.5 text-red-500" aria-label="required">
            *
          </span>
        )}
      </span>
      {children}
    </label>
  );
}
