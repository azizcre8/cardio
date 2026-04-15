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
  '004_deck_hierarchy.sql',
  '005_exam_deadline_rpc.sql',
  '006_shared_banks.sql',
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

async function runSQL(sql: string, label: string): Promise<void> {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ query: sql }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${label} failed (${res.status}): ${body}`);
  }

  console.log(`✓ ${label}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Applying migrations to project: ${PROJECT_REF}\n`);

  const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');

  for (const file of PENDING) {
    const filepath = path.join(migrationsDir, file);
    if (!fs.existsSync(filepath)) {
      console.warn(`⚠ Skipping ${file} — file not found`);
      continue;
    }
    const sql = fs.readFileSync(filepath, 'utf8');
    await runSQL(sql, file);
  }

  console.log('\nAll migrations applied. Restart your dev server to pick up schema changes.');
}

main().catch(err => {
  console.error('\nMigration failed:', err.message);
  process.exit(1);
});
