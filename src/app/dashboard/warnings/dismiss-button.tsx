"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function DismissButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClick = () => {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/dashboard/warnings/${id}`, {
        method: "PATCH",
      });
      if (!res.ok) {
        setError(res.status === 404 ? "Warning not found." : "Could not dismiss.");
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="grid gap-1 sm:justify-items-end">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="inline-flex h-9 items-center rounded-md border border-amber-300 bg-white px-3 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Dismissing…" : "Dismiss"}
      </button>
      {error ? <span className="text-[10px] text-rose-700">{error}</span> : null}
    </div>
  );
}
