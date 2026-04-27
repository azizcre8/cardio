/**
 * End-to-end pipeline smoke test.
 * Usage: npx tsx scripts/test-pipeline.ts
 */
import { generateQuestionsWithClaude } from '@/lib/pipeline/claude-generation';

const SAMPLE_TEXT = `
CARDIAC PHYSIOLOGY

The cardiac cycle consists of systole and diastole. During systole the ventricles
contract and eject blood into the aorta and pulmonary artery. During diastole the
ventricles relax and fill with blood from the atria.

Stroke Volume and Cardiac Output
The stroke volume is approximately 70 mL per beat at rest. Heart rate is typically
60 to 100 beats per minute in adults. Cardiac output equals stroke volume multiplied
by heart rate, yielding approximately 5 liters per minute at rest.

Frank-Starling Mechanism
The Frank-Starling mechanism describes the relationship between ventricular filling
and stroke volume. Increased preload stretches myocardial fibers and increases
contractility through increased overlap of actin and myosin filaments.
Afterload is the resistance the ventricle must overcome to eject blood into the aorta.

Action Potential and Conduction
The cardiac action potential has five phases: rapid depolarization (phase 0) due to
fast sodium channel opening, brief repolarization (phase 1), plateau (phase 2) due to
calcium influx, repolarization (phase 3) via potassium efflux, and resting potential
(phase 4). The sinoatrial node spontaneously depolarizes and sets the heart rate.
The atrioventricular node delays conduction to allow ventricular filling.

Coronary Circulation
Coronary blood flow occurs predominantly during diastole because systolic contraction
compresses intramyocardial vessels. The left ventricle is supplied by the left anterior
descending artery and the circumflex artery. The right coronary artery supplies the
right ventricle and the sinoatrial node in most individuals.
`.trim();

const TEST_PDF_ID = 'test-' + Date.now();
const TEST_USER_ID = 'test-user';
const TARGET_QUESTIONS = 5;

async function main() {
  console.log('Starting pipeline smoke test…');
  console.log(`Target: ${TARGET_QUESTIONS} questions from ${SAMPLE_TEXT.length} chars of text\n`);

  const startMs = Date.now();

  try {
    const { questions, costUSD } = await generateQuestionsWithClaude(
      SAMPLE_TEXT,
      TARGET_QUESTIONS,
      TEST_PDF_ID,
      TEST_USER_ID,
      msg => console.log(' >', msg),
      startMs,
    );

    const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log(`\n✓ Generated ${questions.length} questions in ${elapsedSec}s — cost $${costUSD.toFixed(4)}`);
    console.log(`  Flagged: ${questions.filter(q => q.flagged).length}`);
    console.log(`  L1: ${questions.filter(q => q.level === 1).length}  L2: ${questions.filter(q => q.level === 2).length}  L3: ${questions.filter(q => q.level === 3).length}`);

    if (questions.length > 0) {
      const sample = questions[0]!;
      console.log('\nSample question:');
      console.log(`  Stem: ${sample.stem.slice(0, 100)}…`);
      console.log(`  Options: ${sample.options.length}`);
      console.log(`  Answer index: ${sample.answer}`);
      console.log(`  Evidence: ${sample.evidence_match_type}`);
    }

    process.exit(0);
  } catch (err) {
    console.error('\n✗ Pipeline failed:', err);
    process.exit(1);
  }
}

main();
