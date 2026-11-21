// Codex's skills as what "/" offers, and a message that calls one (skills.ts, input.ts).
import { describe, expect, it } from 'vitest';
import { codexInput } from './input.ts';
import { skillCommands, skillMention, skillsFrom, startsWithSlash } from './skills.ts';

const answer = {
  data: [
    {
      cwd: '/repo',
      errors: [],
      skills: [
        { name: 'review', description: 'Review the diff. A long description.', interface: { shortDescription: 'Review the diff' }, path: '/s/review/SKILL.md', enabled: true, scope: 'user' },
        { name: 'off', description: 'Switched off', path: '/s/off/SKILL.md', enabled: false, scope: 'user' },
        { name: 'review', description: 'A second one of the same name', path: '/t/review/SKILL.md', enabled: true, scope: 'system' },
        { name: 'plain', description: 'No short text', path: '/s/plain/SKILL.md', enabled: true, scope: 'user' },
      ],
    },
  ],
};
const skills = skillsFrom(answer);
const review = skills[0]!;
const text = (words: string) => ({ type: 'text', text: words, text_elements: [] });

describe('Codex skills as slash commands', () => {
  it('lists the enabled skills, each name once, with the short description when there is one', () => {
    expect(skills).toEqual([
      { name: 'review', description: 'Review the diff', path: '/s/review/SKILL.md' },
      { name: 'plain', description: 'No short text', path: '/s/plain/SKILL.md' },
    ]);
    expect(skillCommands(skills)).toEqual([
      { name: 'review', description: 'Review the diff' },
      { name: 'plain', description: 'No short text' },
    ]);
  });

  it('lists nothing when Codex could not say', () => {
    expect(skillsFrom(null)).toEqual([]);
    expect(skillsFrom({ data: 'nope' })).toEqual([]);
  });

  it('sends a message that starts with a listed skill as that skill and the rest of the message', () => {
    const skill = { type: 'skill', name: 'review', path: '/s/review/SKILL.md' };
    expect(codexInput('/review the last commit', [], skills)).toEqual([skill, text(`${skillMention(review)} the last commit`)]);
    expect(codexInput('/review', [], skills)).toEqual([skill, text(skillMention(review))]);
  });

  it('leaves every other message as it was typed', () => {
    for (const typed of ['/unknown thing', '/off now', 'please /review this', '/review/x']) expect(codexInput(typed, [], skills)).toEqual([text(typed)]);
    expect(codexInput('/review it', [], [])).toEqual([text('/review it')]);
  });

  it('asks Codex for its skills only for a message that starts with a slash and a name', () => {
    expect(startsWithSlash('/review x')).toBe(true);
    expect(startsWithSlash('review')).toBe(false);
    expect(startsWithSlash('/ x')).toBe(false);
    expect(startsWithSlash('//x')).toBe(false);
  });
});
