import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
    if (!(key in process.env)) process.env[key] = value;
  }
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const DRY_RUN = !process.argv.includes('--apply');

async function applyUpdate(
  id: string,
  patch: Record<string, unknown>,
  description: string,
) {
  console.log(`\n${DRY_RUN ? '[DRY RUN]' : '[APPLY]'} ${description}`);
  console.log('  id:', id);
  console.log('  patch:', JSON.stringify(patch, null, 2));
  if (DRY_RUN) return;
  const { error } = await supabase.from('questions').update(patch).eq('id', id);
  if (error) {
    console.error('  ERROR:', error.message);
  } else {
    console.log('  OK');
  }
}

async function replaceOption(
  id: string,
  answerIndex: number,
  newText: string,
  description: string,
) {
  // Fetch current options first so we can splice cleanly
  const { data, error } = await supabase
    .from('questions')
    .select('options')
    .eq('id', id)
    .single();
  if (error || !data) {
    console.error(`Could not fetch options for ${id}:`, error?.message);
    return;
  }
  const options: string[] = [...data.options];
  options[answerIndex] = newText;
  await applyUpdate(
    id,
    { options, flagged: false, option_set_flags: null },
    description,
  );
}

async function main() {
  if (DRY_RUN) {
    console.log('=== DRY RUN — pass --apply to write changes ===\n');
  }

  // --- LENGTH_TELL fixes ---

  await replaceOption(
    'eff8f8c4-015a-4406-961b-594b5df1dd2d',
    1,
    'Abnormally short intramural ureteral course',
    'LENGTH_TELL: vesicoureteral reflux (eff8f8c4)',
  );

  await replaceOption(
    'd1d484fc-1f21-4fb2-8c6a-3200a949d01b',
    2,
    'Automatic reflex micturition without cortical control',
    'LENGTH_TELL: suprasacral SCI bladder pattern (d1d484fc)',
  );

  await replaceOption(
    '614bb58b-b026-411f-834e-79b4907f010a',
    1,
    'Loss of erythropoietin secretion',
    'LENGTH_TELL: nephrectomy anemia (614bb58b)',
  );

  await replaceOption(
    '61a9fdf1-5b16-4c98-8394-a92b5414a893',
    1,
    'Afferent bladder sensory fibers',
    'LENGTH_TELL: sacral crush injury bladder (61a9fdf1)',
  );

  await replaceOption(
    '048bfe68-9328-44b6-b1de-7e08fb4ae495',
    1,
    'Ureterorenal sympathetic reflex vasoconstriction',
    'LENGTH_TELL: ureteral stone urine output (048bfe68)',
  );

  await replaceOption(
    'fd4908d0-19c7-4c3b-9963-2ef1f11620dc',
    1,
    '2 to 3 days; mild sodium retention and ECF expansion',
    'LENGTH_TELL: sodium intake increase (fd4908d0)',
  );

  // --- NOT question → positive stem ---

  await applyUpdate(
    '536cf631-1da2-4615-99ce-84dee0a92bd8',
    {
      stem: 'Which of the following is a homeostatic function of the kidney?',
      answer: 0,
      explanation:
        'The kidneys secrete erythropoietin, which directly stimulates red blood cell production. Plasma protein synthesis is a hepatic function and is not performed by the kidney.',
      flagged: false,
      option_set_flags: null,
    },
    'NOT question → positive stem (536cf631)',
  );

  // --- QUOTE_NOT_FOUND fix ---

  await applyUpdate(
    '6b6c136d-ca89-424a-a625-7ecec3512038',
    {
      source_quote:
        'Urinary excretion rate equals filtration rate minus reabsorption rate plus secretion rate',
      flagged: false,
      flag_reason: null,
    },
    'QUOTE_NOT_FOUND: excretion equation prose quote (6b6c136d)',
  );

  console.log('\nDone.');
}

main().catch(console.error);
