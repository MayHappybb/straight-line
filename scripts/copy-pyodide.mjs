// Copy the Pyodide runtime into public/ so the built site is fully self-contained
// (no CDN at run time; the whole thing can sit on GitHub Pages or any static host).
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pyodide');
const dst = join(root, 'public', 'pyodide');
const files = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];

mkdirSync(dst, { recursive: true });
for (const f of files) {
  const from = join(src, f);
  if (!existsSync(from)) throw new Error(`pyodide file missing: ${from} (run npm install)`);
  cpSync(from, join(dst, f));
}
console.log(`pyodide runtime copied to ${dst}`);
