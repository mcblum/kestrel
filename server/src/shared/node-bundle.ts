// The worker node's bundle (docs/designs/worker-nodes.md, section 4): which machines it is built for, what its
// files are called, and how a checksum is written and checked. Pure, so the build script
// (scripts/release/node-bundle/), the release scripts and the tests share one copy. The install script
// (scripts/release/install-node.sh) is POSIX sh and says the same in its own words; its test holds the two together.
//
// Erasable TypeScript only: the build script imports this file with Node's own type stripping.

/** The architectures a bundle is built for, in Node's names. */
export const NODE_BUNDLE_ARCHES = ['x64', 'arm64'] as const;
export type NodeBundleArch = (typeof NODE_BUNDLE_ARCHES)[number];

export const isNodeBundleArch = (value: unknown): value is NodeBundleArch => typeof value === 'string' && (NODE_BUNDLE_ARCHES as readonly string[]).includes(value);

/** `uname -m` as a bundle's architecture. Linux and the BSDs say these; anything else has no bundle. */
const MACHINES: Readonly<Record<string, NodeBundleArch>> = { x86_64: 'x64', amd64: 'x64', aarch64: 'arm64', arm64: 'arm64' };

export type Answer<T> = { ok: true; value: T } | { ok: false; reason: string };

/** What `uname -m` printed, as the bundle to fetch, or why there is none. */
export function archOfMachine(machine: string): Answer<NodeBundleArch> {
  const arch = MACHINES[machine.trim()];
  if (arch) return { ok: true, value: arch };
  return { ok: false, reason: `There is no Kestrel worker node for this processor (${machine.trim() || 'unknown'}). It is built for x86_64 and aarch64 (arm64).` };
}

/** What `uname -s` printed: a worker node is built for Linux only. */
export function platformOfSystem(system: string): Answer<'linux'> {
  if (system.trim() === 'Linux') return { ok: true, value: 'linux' };
  return { ok: false, reason: `A Kestrel worker node runs on Linux; this is ${system.trim() || 'an unknown system'}. On a Mac or Windows, install the Kestrel app.` };
}

/** The bundle's file name: the same in every release, the version is in the folder it is published under. */
export const bundleFileName = (arch: NodeBundleArch): string => `kestrel-node-linux-${arch}.tar.gz`;

/** The checksum file beside it. */
export const checksumFileName = (arch: NodeBundleArch): string => `${bundleFileName(arch)}.sha256`;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** One line of a checksum file, as `sha256sum` writes it and `sha256sum -c` reads it. */
export function checksumLine(hash: string, file: string): string {
  if (!SHA256_HEX.test(hash)) throw new Error(`Not a SHA-256 checksum: ${hash.slice(0, 80)}`);
  return `${hash}  ${file}\n`;
}

/** The checksum a file (`sha256sum` format, one line per file, or `SHASUMS256.txt`) gives `file`, or why it gives none. */
export function checksumFor(text: string, file: string): Answer<string> {
  for (const line of text.split('\n')) {
    const match = /^([0-9a-fA-F]{64}) [ *]?(.+?)\s*$/.exec(line);
    if (match && match[2] === file) return { ok: true, value: match[1]!.toLowerCase() };
  }
  return { ok: false, reason: `The checksum file has no line for ${file}.` };
}

/** Null when `actual` is what was expected; else the refusal. */
export function checksumProblem(expected: string, actual: string, file: string): string | null {
  if (expected.toLowerCase() === actual.toLowerCase()) return null;
  return `The checksum of ${file} does not match (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…). It was not used.`;
}

/** ELF's machine numbers for the two architectures (e_machine, at byte 18). */
const ELF_MACHINE: Readonly<Record<number, NodeBundleArch>> = { 0x3e: 'x64', 0xb7: 'arm64' };

/** Which architecture a Linux program or `.node` module was built for: from its ELF header, or null when it is not a 64-bit little-endian ELF file of either. */
export function elfArchOf(header: Uint8Array): NodeBundleArch | null {
  const isElf = header.length >= 20 && header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46;
  // Class 2 is 64-bit, data 1 is little-endian.
  if (!isElf || header[4] !== 2 || header[5] !== 1) return null;
  return ELF_MACHINE[header[18]! | (header[19]! << 8)] ?? null;
}
