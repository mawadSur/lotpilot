// Vitest config for the LotPilot v0.5 integration suite. Tests are
// in-process (mocked Supabase, mocked AI, mocked Twilio) — they cover
// pipeline behaviour. RLS regressions live in migration 0006's positive-
// control + leak-check (see supabase/migrations/0006_test_isolation.sql).
//
// pool=forks isolates each test file in its own worker, which means
// vi.mock("@/lib/supabase-service") in one file can't bleed into another.

import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    pool: "forks",
    // Per-file isolation: a stubbed createServiceSupabase in one test
    // can't leak into another. Belt-and-braces with pool: 'forks'.
    isolate: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
