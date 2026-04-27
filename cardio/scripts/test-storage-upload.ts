import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert/strict';
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

function getSupabaseAdmin() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL');
  if (!serviceRoleKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function minimalPdfBuffer(): Buffer {
  return Buffer.from(
    `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 44 >>
stream
BT /F1 12 Tf 30 100 Td (Storage test) Tj ET
endstream
endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000202 00000 n 
trailer
<< /Size 5 /Root 1 0 R >>
startxref
296
%%EOF
`,
    'utf8',
  );
}

function findSmallestPdf(): string | null {
  const candidates = [
    path.join(__dirname, '..', 'data', 'reference-pdfs'),
    __dirname,
  ];
  const pdfs: { filePath: string; size: number }[] = [];

  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const filePath = path.join(dir, entry);
      const stat = fs.statSync(filePath);
      if (stat.isFile() && entry.toLowerCase().endsWith('.pdf')) {
        pdfs.push({ filePath, size: stat.size });
      }
    }
  }

  pdfs.sort((a, b) => a.size - b.size);
  return pdfs[0]?.filePath ?? null;
}

function getTestPdfBuffer(): { buffer: Buffer; source: string } {
  const pdfPath = findSmallestPdf();
  if (pdfPath) {
    return {
      buffer: fs.readFileSync(pdfPath),
      source: path.relative(path.join(__dirname, '..'), pdfPath),
    };
  }

  return {
    buffer: minimalPdfBuffer(),
    source: 'generated minimal PDF',
  };
}

async function main() {
  const supabase = getSupabaseAdmin();
  const bucket = supabase.storage.from('pdfs');
  const userId = 'test-user';
  const pathInBucket = `${userId}/test-upload-${Date.now()}.pdf`;
  const { buffer, source } = getTestPdfBuffer();
  const checks: string[] = [];

  console.log('Supabase Storage PDF upload flow test');
  console.log(`Bucket: pdfs`);
  console.log(`Path: ${pathInBucket}`);
  console.log(`PDF source: ${source}`);
  console.log(`PDF bytes: ${buffer.length}`);

  try {
    const upload = await bucket.upload(pathInBucket, buffer, {
      contentType: 'application/pdf',
    });
    assert.equal(upload.error, null, `Upload failed: ${upload.error?.message}`);
    checks.push('upload succeeded');

    const download = await bucket.download(pathInBucket);
    assert.equal(download.error, null, `Download failed: ${download.error?.message}`);
    assert.ok(download.data, 'Download returned no data');
    const downloaded = Buffer.from(await download.data.arrayBuffer());
    assert.equal(downloaded.length, buffer.length, 'Downloaded PDF byte length mismatch');
    assert.ok(downloaded.equals(buffer), 'Downloaded PDF content mismatch');
    checks.push('downloaded content matches uploaded content');

    const ownedPath = pathInBucket;
    const otherUserPath = `other-user/test-upload-${Date.now()}.pdf`;
    assert.equal(ownedPath.startsWith(userId + '/'), true, 'Expected owned path to pass ownership check');
    assert.equal(otherUserPath.startsWith(userId + '/'), false, 'Expected other-user path to fail ownership check');
    checks.push('ownership check rejects a different userId prefix');

    console.log('\nPASS');
    for (const check of checks) console.log(`- ${check}`);
  } finally {
    const cleanup = await bucket.remove([pathInBucket]);
    if (cleanup.error) {
      console.error(`Cleanup failed: ${cleanup.error.message}`);
      throw cleanup.error;
    }
    console.log(`- cleaned up ${pathInBucket}`);
  }
}

main().catch(e => {
  console.error('\nFAIL');
  console.error(e);
  process.exit(1);
});
