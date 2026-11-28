import { terminalColors } from '../../shared/appearance.ts';

export type WorkerPalette = Readonly<{
  ink?: string;
  muted?: string;
  border?: string;
  tile?: string;
  bird?: string;
  selected?: string;
  selectedInk?: string;
  ready?: string;
  caution?: string;
  problem?: string;
}>;

const DARK = terminalColors(true, 'standard');
const LIGHT = terminalColors(false, 'standard');

/** Use the app's neutral surfaces, with the product's green and amber reserved for status. */
export const WORKER_PALETTES = {
  dark: {
    ink: DARK.foreground, muted: '#9a9a9b', border: '#6a6a6c',
    tile: '#2c2c2d', bird: DARK.foreground, selected: DARK.selectionBackground, selectedInk: DARK.foreground,
    ready: '#87ba95', caution: '#ddad67', problem: '#e07b74',
  },
  light: {
    ink: LIGHT.foreground, muted: '#6f6f6f', border: '#949494',
    tile: '#eaeaea', bird: LIGHT.foreground, selected: LIGHT.selectionBackground, selectedInk: LIGHT.foreground,
    ready: '#315b48', caution: '#84561c', problem: '#a23832',
  },
  // An SSH client may never advertise its background. Keep its foreground and use a
  // self-contained brand tile. Shape, text and weight identify focus and status.
  terminal: { tile: '#2c2c2d', bird: DARK.foreground },
  mono: {},
} satisfies Record<string, WorkerPalette>;

export function workerPalette(env: NodeJS.ProcessEnv): WorkerPalette {
  if (env.NO_COLOR !== undefined || env.FORCE_COLOR === '0') return WORKER_PALETTES.mono;
  const background = env.COLORFGBG?.split(';').at(-1);
  if (!background || !/^\d+$/.test(background)) return WORKER_PALETTES.terminal;
  const index = Number(background);
  if (index > 15) return WORKER_PALETTES.terminal;
  return index === 7 || index >= 9 ? WORKER_PALETTES.light : WORKER_PALETTES.dark;
}
