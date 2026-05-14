// First-run wizard. Renders inside the dashboard layout, but the layout
// allows it through without a `dealers` row.

import { redirect } from "next/navigation";
import { requireUserMaybeDealer } from "@/lib/auth";
import { OnboardingWizard } from "./wizard";

export default async function OnboardingPage() {
  const { user, dealer } = await requireUserMaybeDealer();
  if (dealer) {
    redirect("/dashboard");
  }

  return (
    <div className="mx-auto grid max-w-2xl gap-6">
      <header className="grid gap-2">
        <p className="text-xs uppercase tracking-widest text-zinc-500">Step 1 of 1</p>
        <h1 className="text-2xl font-semibold tracking-tight">Set up your dealership</h1>
        <p className="text-sm text-zinc-600">
          You only do this once. Everything below can be edited later in Settings.
        </p>
      </header>

      <OnboardingWizard defaultEmail={user.email ?? undefined} />
    </div>
  );
}
