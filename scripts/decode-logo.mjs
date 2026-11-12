// Binary brand assets cannot travel the file-publishing route, so they
// ship as base64 text (src/assets/*.b64) and are materialized into
// public/ before Vite copies public -> dist.
// - logo.jpg: the retired 2026-10-13 mark; still materialized (its file
//   may remain in public/ unreferenced) — removal is a separate decision.
// - medallion-*.png / favicon-512.png (R45): the owner-designed gold-ring
//   medallion, circular-masked builds from owner-set/avatar-1080.png.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'public'), { recursive: true });

for (const name of ['logo.jpg', 'medallion-96.png', 'medallion-hero.png', 'favicon-512.png']) {
  const bytes = Buffer.from(readFileSync(join(root, 'src/assets', `${name}.b64`), 'utf8').trim(), 'base64');
  writeFileSync(join(root, 'public', name), bytes);
  console.log(`${name} materialized:`, bytes.length, 'bytes');
}
