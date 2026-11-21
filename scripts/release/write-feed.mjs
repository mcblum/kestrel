// Writes latest-mac.yml, the feed electron-updater reads, for the artifacts in a release folder.
//
//   node scripts/release/write-feed.mjs --dir dist/release --version 0.0.1 [--base <url>]
//
// Without --base the entries are bare file names, resolved against wherever the feed is served
// (a local test server). With --base (the publish step) every `url` and `path` is absolute:
// electron-updater resolves each with `new URL(entry, feedBase)`, so an absolute URL is used as
// is and the zip can live somewhere other than the feed. The zip's blockmap must sit at the zip's
// URL + ".blockmap": electron-updater derives it (and the previous version's, by replacing the
// version string in that URL) for differential downloads, and falls back to a full download.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { dir: { type: 'string' }, version: { type: 'string' }, base: { type: 'string' }, out: { type: 'string' } } });
const { dir, version } = values;
if (!dir || !version) {
  console.error('usage: write-feed.mjs --dir <release dir> --version <x.y.z> [--base <absolute url ending in />] [--out <file>]');
  process.exit(2);
}
const base = values.base ?? '';
if (base && !/^https:\/\/.+\/$/.test(base)) {
  console.error(`!! --base must be an https URL ending in /, not ${base}`);
  process.exit(2);
}

const zip = `Kestrel-${version}-arm64-mac.zip`;
const dmg = `Kestrel-${version}-arm64.dmg`;

function sha512(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    createReadStream(path).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('base64'))).on('error', reject);
  });
}

async function entry(name) {
  const path = join(dir, name);
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  return { url: `${base}${name}`, sha512: await sha512(path), size: statSync(path).size };
}

const files = [await entry(zip), await entry(dmg)];
const yml = [
  `version: ${version}`,
  'files:',
  ...files.flatMap((f) => [`  - url: ${f.url}`, `    sha512: ${f.sha512}`, `    size: ${f.size}`]),
  `path: ${files[0].url}`,
  `sha512: ${files[0].sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  '',
].join('\n');
const out = values.out ?? join(dir, 'latest-mac.yml');
writeFileSync(out, yml);
console.log(`==> ${out}`);
