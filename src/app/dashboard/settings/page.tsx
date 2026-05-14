import { requireDealer } from "@/lib/auth";
import { SettingsForm } from "./settings-form";

export default async function SettingsPage() {
  const { dealer } = await requireDealer();
  return (
    <div className="mx-auto grid max-w-2xl gap-6">
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-zinc-600">
          Edit how your dealership appears to buyers and how the AI signs replies.
        </p>
      </header>
      <SettingsForm dealer={dealer} />
    </div>
  );
}
