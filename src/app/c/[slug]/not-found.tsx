import Link from "next/link";

export default function ChatNotFound() {
  return (
    <main className="min-h-dvh bg-zinc-50 text-zinc-900">
      <div className="mx-auto max-w-md px-6 py-16 text-center">
        <h1 className="text-2xl font-semibold">Dealer not found</h1>
        <p className="mt-3 text-sm text-zinc-600">
          We couldn&apos;t find a dealer at this link. Double-check the URL or
          ask the dealer for the correct one.
        </p>
        <p className="mt-6">
          <Link href="/" className="text-sm font-semibold text-zinc-900 underline">
            Back to LotPilot
          </Link>
        </p>
      </div>
    </main>
  );
}
