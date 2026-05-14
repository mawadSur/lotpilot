// Vitest global setup. Runs before every test file in this project.
//
// Two things happen here:
//   1. Process env defaults — without these, `src/lib/env.ts` raises on
//      first import, and any file that pulls in chat-pipeline.ts (which
//      it imports transitively via supabase-service.ts) would die at
//      module-load. We set the *required* knobs to test-only values so
//      ImportTime works. Tests can still override per-case via the
//      module mocks in tests/helpers/mock-pipeline.ts.
//
//   2. We do NOT register vi.mock here. vi.mock auto-hoists to the top
//      of the importing file (this is a Vitest quirk that surprises
//      people every release), and a vi.mock("./@/lib/supabase-service")
//      in setup.ts ends up hoisted in setup.ts only — useless for the
//      test files. Each test imports the helper which performs its
//      own vi.mock calls at the top of THAT file.

// Belt-and-braces: env defaults so any module that reads env at
// import-time doesn't trip. The real values come in through vi.mock.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://test.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-key";
process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
process.env.ANTHROPIC_DAILY_BUDGET_USD ??= "1000";
