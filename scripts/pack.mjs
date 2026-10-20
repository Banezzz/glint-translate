// Packs only the files the extension needs into dist/glint-translate-v<version>.zip,
// ready for "Load unpacked" (after unzipping) or the Chrome Web Store.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const out = join(ROOT, 'dist', `glint-translate-v${version}.zip`);

mkdirSync(dirname(out), { recursive: true });
rmSync(out, { force: true });
execFileSync('zip', ['-q', '-r', '-X', out, 'manifest.json', '_locales', 'icons', 'src', '-x', '*.DS_Store'], { cwd: ROOT, stdio: 'inherit' });
console.log(`packed ${out}`);
