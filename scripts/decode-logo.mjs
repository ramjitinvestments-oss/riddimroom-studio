// The locked brand logo is a binary JPG that the file-publishing route
// cannot carry, so it travels as base64 text (src/assets/logo.jpg.b64)
// and is materialized into public/ before Vite copies public -> dist.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bytes = Buffer.from(readFileSync(join(root, 'src/assets/logo.jpg.b64'), 'utf8').trim(), 'base64');
mkdirSync(join(root, 'public'), { recursive: true });
writeFileSync(join(root, 'public/logo.jpg'), bytes);
console.log('logo.jpg materialized:', bytes.length, 'bytes');
