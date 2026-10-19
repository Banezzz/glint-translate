// Static checks for the unpacked extension: the manifest is well-formed and
// every file it (or an extension page) references exists.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const fail = (message) => errors.push(message);

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) fail(`invalid version "${manifest.version}"`);
if (manifest.version !== pkg.version) fail(`manifest version ${manifest.version} != package.json version ${pkg.version}`);
if (manifest.name.length > 75) fail('name is longer than 75 characters');
if (manifest.description.length > 132) fail('description is longer than 132 characters');

const referenced = new Set([
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  manifest.action?.default_popup,
  manifest.options_page,
  manifest.background?.service_worker,
  ...(manifest.content_scripts ?? []).flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])]),
]);
referenced.delete(undefined);

for (const file of referenced) {
  if (!existsSync(join(ROOT, file))) fail(`manifest references missing file ${file}`);
}

// Scripts, styles and images referenced from extension pages.
for (const page of [manifest.action?.default_popup, manifest.options_page].filter(Boolean)) {
  const html = readFileSync(join(ROOT, page), 'utf8');
  for (const [, url] of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
    const target = resolve(ROOT, dirname(page), url);
    if (!existsSync(target)) fail(`${page} references missing file ${relative(ROOT, target)}`);
  }
  if (/<script(?![^>]*\bsrc=)[^>]*>/.test(html)) fail(`${page} contains an inline script (blocked by extension CSP)`);
}

// ES module imports inside src/ must resolve to existing files.
function checkImports(file, seen = new Set()) {
  if (seen.has(file)) return;
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  for (const [, spec] of source.matchAll(/^\s*import\s+(?:[^'"]+from\s+)?['"](\.[^'"]+)['"]/gm)) {
    const target = resolve(dirname(file), spec);
    if (!existsSync(target)) fail(`${relative(ROOT, file)} imports missing ${spec}`);
    else checkImports(target, seen);
  }
}
checkImports(join(ROOT, manifest.background.service_worker));
for (const page of [manifest.action?.default_popup, manifest.options_page]) {
  const html = readFileSync(join(ROOT, page), 'utf8');
  for (const [, src] of html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)) {
    checkImports(resolve(ROOT, dirname(page), src));
  }
}

if (errors.length) {
  console.error(`✖ ${errors.length} problem(s):\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  process.exit(1);
}
console.log(`✔ manifest v${manifest.version}: ${referenced.size} referenced files present, pages and imports resolve`);
