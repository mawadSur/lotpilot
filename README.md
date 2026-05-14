# LotPilot

The bilingual AI sales assistant for independent used-car dealers.
Every Marketplace, SMS, and web lead answered in 60 seconds, in
English or Spanish — 24/7.

This repo is the marketing landing page + dealer waitlist for the
private beta.

## Stack

- Next.js 16 (App Router) + TypeScript strict mode
- Tailwind CSS v4
- Supabase (Postgres + RLS) for waitlist storage
- Deployed to Vercel

## Run locally

```bash
npm install
cp .env.example .env.local   # then edit with your Supabase keys
npm run dev
```

Open http://localhost:3000.

The site builds and runs without Supabase keys — the form will just
show a thank-you message instead of persisting signups. Wire up
Supabase before going live.

## Set up Supabase

1. Create a project at https://supabase.com (free tier is fine).
2. In the dashboard: **SQL Editor → New query**, paste the contents of
   [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql)
   and run it. This creates the `dealer_signups` table with row-level
   security (anon role can insert, only the service role can read).
3. **Project Settings → API**, copy:
   - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` `public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
4. Paste them into `.env.local` and restart the dev server.

To review signups, open the Supabase dashboard → **Table Editor →
dealer_signups**.

### Local Supabase (optional)

If you have the [Supabase CLI](https://supabase.com/docs/guides/cli)
installed, you can run the stack locally:

```bash
supabase start
supabase db reset   # applies supabase/migrations/0001_init.sql
```

## Deploy to Vercel

```bash
npm install -g vercel
vercel login
vercel              # first deploy creates the project + preview URL
vercel --prod       # promote to production
```

Set the same two env vars in the Vercel dashboard (Project →
Settings → Environment Variables) for `Production` and `Preview`.

## Project layout

```
src/
  app/
    actions.ts        Server action — validates + inserts signup
    layout.tsx        Root layout, metadata, fonts
    page.tsx          Landing page
    signup-form.tsx   Client component — useActionState form
  lib/
    supabase.ts       Lazily-cached Supabase anon client
supabase/
  migrations/
    0001_init.sql     dealer_signups table + RLS policies
```

## Scope (today)

- One screen, one CTA: the dealer waitlist.
- Persists signups under RLS so the founder can review in Supabase.

Conversation flow, Marketplace integration, calendar booking, and
the bilingual response engine come next — this is the wedge, not the
product.
