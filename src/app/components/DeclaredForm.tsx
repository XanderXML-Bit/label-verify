"use client";

import { useState } from "react";
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
        <Field label="Brand name" required>
          <input
            type="text"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            disabled={disabled}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </Field>
        <Field label="Class / type" required>
          <input
            type="text"
            value={classType}
            onChange={(e) => setClassType(e.target.value)}
            disabled={disabled}
            placeholder="e.g. India Pale Ale"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </Field>
        <Field label="Category" required>
          <select
            value={classCategory}
            onChange={(e) =>
              setClassCategory(e.target.value as DeclaredFields["class_category"])
            }
            disabled={disabled}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="beer">Beer / Malt Beverage</option>
            <option value="wine">Wine</option>
            <option value="distilled_spirits">Distilled Spirits</option>
            <option value="fortified_wine">Fortified Wine</option>
          </select>
        </Field>
        <Field label="ABV (%)" required>
          <input
            type="number"
            step="0.1"
            min="0"
            max="100"
            value={abv}
            onChange={(e) => setAbv(e.target.value)}
            disabled={disabled}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </Field>
        <Field label="Net contents value" required>
          <input
            type="number"
            step="0.1"
            min="0"
            value={ncValue}
            onChange={(e) => setNcValue(e.target.value)}
            disabled={disabled}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </Field>
        <Field label="Net contents unit" required>
          <select
            value={ncUnit}
            onChange={(e) =>
              setNcUnit(e.target.value as "fl_oz" | "ml" | "L" | "cl")
            }
            disabled={disabled}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="fl_oz">fl oz</option>
            <option value="ml">ml</option>
            <option value="cl">cl</option>
            <option value="L">L</option>
          </select>
        </Field>
        <Field label="Producer / address">
          <textarea
            value={producer}
            onChange={(e) => setProducer(e.target.value)}
            disabled={disabled}
            rows={2}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </Field>
        <Field label="Country of origin" required>
          <input
            type="text"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            disabled={disabled}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </Field>
      </div>

      {errors.length > 0 && (
        <div
          role="alert"
          aria-live="polite"
          className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800"
        >
          <ul className="list-inside list-disc">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <button
        type="submit"
        disabled={disabled}
        className="rounded-md bg-blue-600 px-6 py-2.5 text-base font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        Verify
      </button>
    </form>
  );
}

function Field({
  label,
  children,
  required,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
  readonly required?: boolean;
}) {
  return (
    <label className="block">
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
