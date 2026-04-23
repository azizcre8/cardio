# Cardio Launch Workflow

## 1. Source of truth

The source of truth for the app is:

- `/Users/sajedaziz/Documents/Claude/pdf/cardio`

Do not build new product work in root-level HTML files.

## 2. Local workflow

Run all app commands from `cardio`:

```bash
cd /Users/sajedaziz/Documents/Claude/pdf/cardio
npm install
npm run dev
```

Use these checks before shipping:

```bash
npm run test:run
npm run build
```

## 3. How localhost maps to production

`localhost:3000` is the same Next.js app that should be deployed to production.

The only differences between local and production should be:

- environment variables
- domain / auth callback URLs
- billing keys
- production data

The app does **not** need to be converted into a different kind of website. It already is a website.

## 4. Codex and Claude workflow

Use Codex for:

- codebase inspection
- code edits
- refactors
- test/build verification
- deployment cleanup

Use Claude for:

- product thinking
- UX critique
- prompt and workflow brainstorming
- high-level tradeoff discussion

For either tool, start prompts with:

```text
Work only in /Users/sajedaziz/Documents/Claude/pdf/cardio
```

And ask for:

- files changed
- commands run
- build/test status

## 5. Deployment workflow

Preferred host: Vercel.

Canonical setup:

1. Create or update the Vercel project.
2. Set the root directory to `cardio`.
3. Add production environment variables from `.env.local.example` plus your real values.
4. Set `NEXT_PUBLIC_SITE_URL` to your real production domain.
5. Add that domain to Supabase Auth allowed URLs.
6. Deploy.

After deploy, verify:

- `/` renders the public site
- `/login` works
- `/app` redirects correctly when logged out
- auth persists on the production domain
- PDF processing works
- Stripe webhook is configured if billing is enabled

## 6. What to simplify before launch

Focus on reducing moving parts, not adding more.

Recommended order:

1. Keep one upload flow and one study flow.
2. Reduce question-generation rules that overlap or fight each other.
3. Remove or disable feature flags you are not actively using.
4. Test with a small set of real PDFs and inspect outputs manually.
5. Launch narrow, then harden from real usage.

## 7. Safe repo rule

Do not delete legacy references casually, but do keep them out of the main app path. Anything in `/legacy` is reference material, not runtime code.
