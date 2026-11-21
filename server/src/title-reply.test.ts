import { describe, expect, it } from 'vitest';
import { MAX_TITLE_TAGS, parseTitleReply, TITLE_TAG_REASON } from './title-reply.ts';

describe('parseTitleReply', () => {
  it('reads a reply with only a title', () => {
    expect(parseTitleReply('Debug upload page hang')).toEqual({ title: 'Debug upload page hang', tags: [] });
    expect(parseTitleReply('"Debug upload page hang."')).toEqual({ title: 'Debug upload page hang', tags: [] });
  });

  it('reads the title and the tag lines after it', () => {
    const reply = parseTitleReply('Fix upload hang\ntag: PROJ-482 | ticket | Jira\nTag: v2.3 | release |');
    expect(reply.title).toBe('Fix upload hang');
    expect(reply.tags).toEqual([
      { tag: 'PROJ-482', category: 'ticket', source: 'Jira', reason: TITLE_TAG_REASON },
      { tag: 'v2.3', category: 'release', reason: TITLE_TAG_REASON },
    ]);
  });

  it('takes a title that comes after a tag line, and markdown around tag lines', () => {
    const reply = parseTitleReply('- **tag:** `ENG-42` | Ticket | none\n\nRename the session tabs');
    expect(reply.title).toBe('Rename the session tabs');
    expect(reply.tags).toEqual([{ tag: 'ENG-42', category: 'ticket', reason: TITLE_TAG_REASON }]);
  });

  it('ignores a malformed tags part and keeps the title', () => {
    for (const raw of ['Fix upload hang\ntag: PROJ-482', 'Fix upload hang\ntags: none', 'Fix upload hang\ntag: | ticket | Jira', 'Fix upload hang\ntag: PROJ-482 | epic | Jira']) {
      expect(parseTitleReply(raw)).toEqual({ title: 'Fix upload hang', tags: [] });
    }
  });

  it('keeps at most a few candidates', () => {
    const lines = Array.from({ length: 6 }, (_, i) => `tag: A-${i} | ticket |`).join('\n');
    expect(parseTitleReply(`Title here\n${lines}`).tags).toHaveLength(MAX_TITLE_TAGS);
  });

  it('has no title when only tag lines came back', () => {
    expect(parseTitleReply('tag: PROJ-1 | ticket | Jira').title).toBeNull();
  });
});
