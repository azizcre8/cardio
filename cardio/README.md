# Cardio

Cardio is a Next.js app for medical study workflows:

- public marketing site at `/`
- authentication at `/login`
- authenticated product at `/app`
- PDF-to-question-bank generation with Supabase, OpenAI, and optional Stripe billing

## Local development

1. Copy `.env.example` to `.env.local`.
2. Fill in the required Supabase and OpenAI keys.
3. Install dependencies and start the dev server.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Required environment variables

Minimum for auth + app:

- `NEXT_PUBLIC_SITE_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

Minimum for generation:

- `OPENAI_API_KEY`

Required only if billing is enabled:

- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_STUDENT_PRICE_ID`
- `STRIPE_BOARDS_PRICE_ID`

## Supabase setup

Run the SQL migrations in:

- `supabase/migrations/001_initial.sql`
- `supabase/migrations/002_add_item_design_columns.sql`

Then configure Supabase Auth:

- add your local and production site URLs
- add the `/app` callback target for Google OAuth if you use Google sign-in
- confirm the `handle_new_user` trigger is present in production

## Production deployment

Deploy the Next.js app in this directory, `cardio`, as the website root.

Important:

- do not deploy the old root-level static HTML as `/`
- do not keep redirects that rewrite `/` to `medical-study-app-v2.html`
- use `/` for the website and `/app` for the signed-in experience

Suggested Vercel setup:

1. Create a project with the root directory set to `cardio`.
2. Add all production environment variables.
3. Deploy.

After deploy, verify:

- `/` loads the public site
- `/login` works
- `/app` redirects unauthenticated users to login
- Supabase auth cookies persist on the production domain
- PDF generation works with production OpenAI and Supabase credentials

## Build verification

```bash
npm run build
```

Use the production build as the final pre-deploy check.
