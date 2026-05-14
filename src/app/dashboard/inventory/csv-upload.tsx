"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { uploadInventoryCsv, type UploadResult, type UploadState } from "./actions";

const initial: UploadState = { status: "idle" };

function UploadButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-10 items-center justify-center rounded-md bg-zinc-900 px-4 text-sm font-semibold text-white hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Uploading…" : "Upload CSV"}
    </button>
  );
}

export function CsvUpload() {
  const [state, action] = useActionState(uploadInventoryCsv, initial);

  return (
    <div className="grid gap-3 rounded-xl border border-zinc-200 bg-white p-5">
      <div className="grid gap-1">
        <h2 className="text-sm font-semibold tracking-tight text-zinc-900">Upload inventory CSV</h2>
        <p className="text-xs text-zinc-500">
          Required column: <code className="font-mono">stock_number</code>. Optional:{" "}
          <code className="font-mono">vin, year, make, model, trim, mileage, price, photo_url, description, status</code>.
          Rows with the same <code className="font-mono">stock_number</code> overwrite the existing vehicle.
        </p>
      </div>

      <form action={action} className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="file"
          name="file"
          accept=".csv,text/csv"
          required
          className="block w-full text-sm text-zinc-700 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-zinc-900 hover:file:bg-zinc-200"
        />
        <UploadButton />
      </form>

      {state.status === "error" ? (
        <p
          role="alert"
          className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700"
        >
          {state.message}
        </p>
      ) : null}

      {state.status === "ok" ? <UploadSummary result={state.result} /> : null}
    </div>
  );
}

function UploadSummary({ result }: { result: UploadResult }) {
  return (
    <div className="grid gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
      <p className="font-semibold">
        Processed {result.totalRows} row{result.totalRows === 1 ? "" : "s"}.
      </p>
      <ul className="text-xs text-emerald-800">
        <li>{result.inserted} inserted</li>
        <li>{result.updated} updated</li>
        <li>{result.errors.length} skipped</li>
      </ul>
      {result.errors.length > 0 ? (
        <details className="mt-1 rounded-md bg-white/60 p-2 text-xs">
          <summary className="cursor-pointer font-medium text-emerald-900">
            Show skipped rows
          </summary>
          <ul className="mt-2 list-inside list-disc space-y-0.5">
            {result.errors.slice(0, 50).map((e) => (
              <li key={`${e.row}-${e.reason}`}>
                Row {e.row}: {e.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
