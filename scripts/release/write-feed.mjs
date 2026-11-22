// Writes the feed electron-updater reads, for one platform's artifacts in a release folder:
//
//   mac      latest-mac.yml           the update zip, then the DMG
//   win      latest.yml               the NSIS installer
//   linux    latest-linux.yml         the AppImage (latest-linux-arm64.yml for --arch arm64)
//
//   node scripts/release/write-feed.mjs --dir dist/release --version 0.0.1 [--platform mac|win|linux]
//                                       [--arch x64|arm64] [--base <url>] [--out <file>]
//
// --platform defaults to mac, --arch to arm64 for mac and x64 otherwise.
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

import { feedFiles } from './feed-files.mjs';

const { values } = parseArgs({ options: { dir: { type: 'string' }, version: { type: 'string' }, platform: { type: 'string', default: 'mac' }, arch: { type: 'string' }, base: { type: 'string' }, out: { type: 'string' } } });
const { dir, version, platform } = values;
if (!dir || !version || !['mac', 'win', 'linux'].includes(platform)) {
  console.error('usage: write-feed.mjs --dir <release dir> --version <x.y.z> [--platform mac|win|linux] [--arch x64|arm64] [--base <absolute url ending in />] [--out <file>]');
  process.exit(2);
}
const arch = values.arch ?? (platform === 'mac' ? 'arm64' : 'x64');
const base = values.base ?? '';
if (base && !/^https:\/\/.+\/$/.test(base)) {
  console.error(`!! --base must be an https URL ending in /, not ${base}`);
  process.exit(2);
}

const names = feedFiles(platform, arch, version);

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

const files = await Promise.all(names.files.map(entry));
const yml = [
  `version: ${version}`,
  'files:',
  ...files.flatMap((f) => [`  - url: ${f.url}`, `    sha512: ${f.sha512}`, `    size: ${f.size}`]),
  `path: ${files[0].url}`,
  `sha512: ${files[0].sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  '',
].join('\n');
const out = values.out ?? join(dir, names.feed);
writeFileSync(out, yml);
console.log(`==> ${out}`);
