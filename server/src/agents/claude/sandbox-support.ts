// Whether this computer can sandbox a Claude session's commands at all. Claude Code's sandbox is
// Seatbelt on macOS and bubblewrap (with socat, for the network) on Linux; it has none on Windows.
// With `sandbox.enabled` and no sandbox to be had the SDK ends the run with an error
// (`failIfUnavailable` defaults to true), so Kestrel asks first and, where there is none, holds a
// confined session another way: every one of its commands asks (sandbox.ts `unconfinedReason`).
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { platformOf, type Platform } from '../../shared/platform.ts';

export type SandboxSupport = { available: true } | { available: false; reason: string };

export const NO_SANDBOX_ON_WINDOWS = 'Claude Code has no command sandbox on Windows';
export const noSandboxOnLinux = (missing: readonly string[]): string => `the command sandbox on Linux needs ${missing.join(' and ')} installed (then restart Kestrel)`;

/** The programs the Linux sandbox runs, by the package that brings each. */
const LINUX_NEEDS = [
  { program: 'bwrap', name: 'bubblewrap' },
  { program: 'socat', name: 'socat' },
] as const;

/** Pure: `has` says whether a program is on PATH. */
export function sandboxSupport(platform: Platform, has: (program: string) => boolean): SandboxSupport {
  if (platform === 'mac') return { available: true };
  if (platform === 'windows') return { available: false, reason: NO_SANDBOX_ON_WINDOWS };
  const missing = LINUX_NEEDS.filter((need) => !has(need.program)).map((need) => need.name);
  return missing.length === 0 ? { available: true } : { available: false, reason: noSandboxOnLinux(missing) };
}

const onPath = (env: Record<string, string | undefined>) => (program: string): boolean =>
  (env.PATH ?? '').split(delimiter).filter(Boolean).some((dir) => existsSync(join(dir, program)));

let known: SandboxSupport | null = null;

/** This computer's answer, worked out once: installing what is missing takes effect at the next start. */
export function hostSandboxSupport(): SandboxSupport {
  known ??= sandboxSupport(platformOf(process.platform), onPath(process.env));
  return known;
}
