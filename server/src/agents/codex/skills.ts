// What "/" offers in a Codex session. Codex's app-server has no slash commands (those belong to
// its own terminal UI); what it lists is skills (`skills/list`, checked on codex-cli 0.167.2,
// 2026-11-18), and a turn takes one as an input item of its own (`UserInput`'s `skill`). So the
// menu lists the enabled skills, and a message that starts with "/name" of a listed skill goes to
// Codex as that skill plus the rest of the message. Pure, except `listSkills`, which asks.
import type { SlashCommand } from '../../shared/slash-commands.ts';
import type { RpcConnection } from './rpc.ts';

export interface CodexSkill {
  name: string;
  description: string;
  /** Where its SKILL.md is: what Codex wants back with the name. */
  path: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The enabled skills in a `skills/list` answer, each name once (the first listed wins). */
export function skillsFrom(answer: unknown): CodexSkill[] {
  const entries = isObj(answer) && Array.isArray(answer.data) ? answer.data.filter(isObj) : [];
  const found = new Map<string, CodexSkill>();
  for (const entry of entries) {
    for (const skill of Array.isArray(entry.skills) ? entry.skills.filter(isObj) : []) {
      const name = str(skill.name);
      const path = str(skill.path);
      if (!name || !path || skill.enabled === false || found.has(name)) continue;
      const short = (isObj(skill.interface) ? str(skill.interface.shortDescription) : '') || str(skill.shortDescription);
      found.set(name, { name, path, description: short || str(skill.description) });
    }
  }
  return [...found.values()];
}

export const skillCommands = (skills: readonly CodexSkill[]): SlashCommand[] => skills.map(({ name, description }) => ({ name, description }));

/** A message that starts with a slash and a name: worth asking Codex for its skills before it is sent. */
export const startsWithSlash = (text: string): boolean => /^\/[^\s/]/.test(text);

/** The listed skill a message starts with ("/name" or "/name and the rest"), and the rest; null when it names none. */
export function skillCalled(text: string, skills: readonly CodexSkill[]): { skill: CodexSkill; rest: string } | null {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text);
  const skill = match ? skills.find((s) => s.name === match[1]) : undefined;
  return skill ? { skill, rest: (match![2] ?? '').trim() } : null;
}

/** How a skill is named in the text that goes with it, as Codex's own UI writes it. */
export const skillMention = (skill: CodexSkill): string => `$${skill.name}`;

/** The skills Codex offers a session working in `directory`. Empty when it cannot say. */
export async function listSkills(rpc: RpcConnection, directory: string): Promise<CodexSkill[]> {
  return skillsFrom(await rpc.request('skills/list', { cwds: [directory] }).catch(() => null));
}
