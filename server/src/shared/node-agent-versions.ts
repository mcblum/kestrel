// The versions of Codex and OpenCode a worker node installs (docs/designs/worker-nodes.md, section 6), purely. Each is
// pinned to the version Kestrel's adapter was built and tried against, never `@latest`: OpenCode moves fast and its
// server must match the SDK Kestrel talks to it with (1.19.6 was the newest on 2026-11-27 while the server's SDK was
// 1.14.25, and 1.19's npm package needs a postinstall script that npm no longer runs by default). The pins are written
// into the bundle at build time (`agents.json` beside `VERSION`, by make-node-bundle.mjs from this function), so an
// installed node knows them without a checkout; a new bundle brings new pins, and the checklist offers to move an
// installed agent to its pin. Erasable TypeScript only: the build script imports this file with Node's type stripping.

export type PinnedAgent = 'codex' | 'opencode';

/** What each pinned agent is installed as, and the version. */
export type AgentPins = Readonly<Record<PinnedAgent, string>>;

/**
 * Codex: the version the worker-node spike ran a turn through Kestrel's adapter with, on Linux (docs/spike-results.md,
 * "Worker nodes"; the desktop adapter was written against 0.167.2, and `codex app-server`'s protocol held between the
 * two). Moved by hand, after a turn through the adapter on the new version.
 */
export const CODEX_TESTED_VERSION = '0.172.0';

/** OpenCode's SDK in server/package.json: the OpenCode server the node runs must be the same release. */
export const OPENCODE_SDK_PACKAGE = '@opencode-ai/sdk';

/** The file in the bundle, beside `VERSION`. */
export const AGENT_PINS_FILE = 'agents.json';

/** Why the checklist installs this version and not the newest, said when they differ. */
export const PIN_WHY: Readonly<Record<PinnedAgent, string>> = {
  codex: 'the version Kestrel was tried with',
  opencode: 'the version of the OpenCode SDK this Kestrel is built with',
};

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export const isExactVersion = (value: unknown): value is string => typeof value === 'string' && EXACT.test(value);

/**
 * The pins, from the server's package.json as the build reads it. Throws when OpenCode's SDK is not pinned to one exact
 * version (a range would let the bundle and the node disagree).
 */
export function agentPinsOf(serverPackage: { dependencies?: Record<string, string> }): AgentPins {
  const sdk = serverPackage.dependencies?.[OPENCODE_SDK_PACKAGE];
  if (!isExactVersion(sdk)) throw new Error(`${OPENCODE_SDK_PACKAGE} in server/package.json must be one exact version (it is ${sdk ?? 'missing'}).`);
  return { codex: CODEX_TESTED_VERSION, opencode: sdk };
}

/** The pins as the bundle carries them. */
export const agentPinsText = (pins: AgentPins): string => `${JSON.stringify({ codex: pins.codex, opencode: pins.opencode }, null, 2)}\n`;

/** The pins a bundle carries, or null when the file is missing or not what the build writes. Never throws. */
export function parseAgentPins(text: string | null): AgentPins | null {
  if (text === null) return null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    return isExactVersion(raw.codex) && isExactVersion(raw.opencode) ? { codex: raw.codex, opencode: raw.opencode } : null;
  } catch {
    return null;
  }
}

/** What the checklist does with an installed agent: nothing (it is the pinned version), or offer to move it there. */
/** `down`: the pin is older than what is installed, so the agent's own data, written by the newer one, may not open. */
export type PinMove = { move: false } | { move: true; from: string | null; to: string; down: boolean };

/** -1, 0 or 1 by the numbers of two versions ("1.14.25" < "1.19.6"); a pre-release suffix is not weighed. Pure. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[-+]/)[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  return 0;
}

/** Pure: an installed version against its pin. An agent whose version could not be read is offered the pin too. */
export function pinMoveOf(installed: string | null, pinned: string): PinMove {
  if (installed === pinned) return { move: false };
  return { move: true, from: installed, to: pinned, down: installed !== null && compareVersions(pinned, installed) < 0 };
}

/**
 * Said before the yes that moves an agent down (OpenCode 1.19.6 to 1.14.25 on a live node, 2026-11-27, whose database
 * the older one could not open). Pure.
 */
export function downgradeNote(label: string, from: string, to: string): string {
  return `${to} is older than the ${from} installed: ${label}'s own data, written by ${from}, may not open in ${to}.`;
}

/** The line the checklist says about the version it installs, naming the newest when it differs. Pure. */
export function pinNote(agent: PinnedAgent, pinned: string, newest: string | null): string | null {
  if (!newest || newest === pinned) return null;
  return `It installs ${pinned}, ${PIN_WHY[agent]}; the newest is ${newest}. Upgrading the node (kestrel upgrade) brings newer pins.`;
}
