import { describe, expect, it } from 'vitest';
import { codexPrompt } from './codex/title.ts';
import { MAX_LISTED_TAGS } from './instruction.ts';
import { TITLE_INSTRUCTION, titleRequest } from './title-request.ts';

describe('what a title provider is asked', () => {
  it('is the message alone when no tags are in use', () => {
    expect(titleRequest('  Fix the upload hang ')).toBe('<message>\nFix the upload hang\n</message>');
  });

  it('lists the tags in use after the message, the first few only, for the tag lines to reuse', () => {
    expect(titleRequest('Add a flag to the Argus CLI', ['Argus', 'Billing'])).toBe('<message>\nAdd a flag to the Argus CLI\n</message>\n<tags>\nArgus\nBilling\n</tags>');
    const many = Array.from({ length: MAX_LISTED_TAGS + 5 }, (_, i) => `tag-${i}`);
    expect(titleRequest('x', many)).toContain(`tag-${MAX_LISTED_TAGS - 1}\n</tags>`);
    expect(TITLE_INSTRUCTION).toMatch(/write that tag exactly as listed instead of a new, more specific one/);
  });

  it('gives Codex the same request', () => {
    expect(codexPrompt('Add a flag', ['Argus'])).toBe(`${TITLE_INSTRUCTION}\n\n${titleRequest('Add a flag', ['Argus'])}`);
  });
});
