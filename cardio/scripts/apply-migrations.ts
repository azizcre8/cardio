/**
 * apply-migrations.ts
 *
 * Applies pending Supabase SQL migrations via the Management API.
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=<personal-access-token> npx tsx scripts/apply-migrations.ts
 *
 * Get your personal access token at:
 *   https://supabase.com/dashboard/account/tokens
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────────────

const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const rawValue = trimmed.slice(eqIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

if (!ACCESS_TOKEN) {
  console.error('Error: SUPABASE_ACCESS_TOKEN env var is required.');
  console.error('Get yours at: https://supabase.com/dashboard/account/tokens');
  process.exit(1);
}
if (!SUPABASE_URL) {
  console.error('Error: NEXT_PUBLIC_SUPABASE_URL env var is required.');
  console.error('Make sure you run this from the cardio/ directory with .env.local loaded.');
  process.exit(1);
}

// Extract project ref from URL: https://<ref>.supabase.co
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split('.')[0];

// ─── Migrations to apply ──────────────────────────────────────────────────────

const DEFAULT_PENDING = [
  '002_add_item_design_columns.sql',
  '003_add_pdf_jobs.sql',
  '004_deck_hierarchy.sql',
  '005_exam_deadline_rpc.sql',
  '006_shared_banks.sql',
  '007_question_concept_name_and_shared_bank_policy_fix.sql',
];

const explicitMigrations = process.argv.slice(2).filter(Boolean);
const envMigrations = (process.env.MIGRATIONS ?? '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const PENDING = explicitMigrations.length > 0
  ? explicitMigrations
  : envMigrations.length > 0
    ? envMigrations
    : DEFAULT_PENDING;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function callSupabaseQuery(sql: string, label: string): Promise<string> {
  const url = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
  const payload = JSON.stringify({ query: sql });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
      body: payload,
    });

    const body = await res.text();
    if (!res.ok) {
      throw new Error(`${label} failed (${res.status}): ${body}`);
    }
    return body;
  } catch (error) {
    // Some environments fail on Node's fetch with ENETUNREACH for IPv6 routes
    // while `curl` works. Fall back to curl so migrations can still run.
    try {
      return execFileSync(
        'curl',
        [
          '--silent',
          '--show-error',
          '--fail-with-body',
          '-X',
          'POST',
          url,
          '-H',
          'Content-Type: application/json',
          '-H',
          `Authorization: Bearer ${ACCESS_TOKEN}`,
          '--data-raw',
          payload,
        ],
        { stdio: 'pipe', encoding: 'utf8' },
      ) as string;
    } catch (curlError) {
      const fetchMessage = error instanceof Error ? error.message : String(error);
      const curlMessage = curlError instanceof Error ? curlError.message : String(curlError);
      throw new Error(`${label} failed via fetch (${fetchMessage}) and curl (${curlMessage})`);
    }
  }
}

async function runSQL(sql: string, label: string): Promise<void> {
  await callSupabaseQuery(sql, label);
  console.log(`✓ ${label}`);
}

async function hasMigration(file: string): Promise<boolean> {
  const escaped = file.replace(/'/g, "''");
  const res = await callSupabaseQuery(
    `select exists(select 1 from public.codex_schema_migrations where filename = '${escaped}') as applied;`,
    `check migration ${file}`,
  );
  const parsed = JSON.parse(res) as Array<{ applied: boolean }>;
  return parsed[0]?.applied === true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Applying migrations to project: ${PROJECT_REF}\n`);

  const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
  await runSQL(
    `
      create table if not exists public.codex_schema_migrations (
        filename text primary key,
        applied_at timestamptz not null default now()
      );
    `,
    'ensure codex_schema_migrations',
  );

  for (const file of PENDING) {
    if (await hasMigration(file)) {
      console.log(`↷ ${file} already recorded, skipping`);
      continue;
    }

    const filepath = path.join(migrationsDir, file);
    if (!fs.existsSync(filepath)) {
      console.warn(`⚠ Skipping ${file} — file not found`);
      continue;
    }
    const sql = fs.readFileSync(filepath, 'utf8');
    await runSQL(sql, file);
    await runSQL(
      `insert into public.codex_schema_migrations(filename) values ('${file.replace(/'/g, "''")}')`,
      `record ${file}`,
    );
  }

  console.log('\nAll migrations applied. Restart your dev server to pick up schema changes.');
}

main().catch(err => {
  console.error('\nMigration failed:', err.message);
  process.exit(1);
});
