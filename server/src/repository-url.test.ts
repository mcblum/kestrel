import { describe, expect, it } from 'vitest';
import { repositoryWebUrl } from './repository-url.ts';

describe('repositoryWebUrl', () => {
  it('handles hosted HTTPS and SSH origins, including nested groups', () => {
    expect(repositoryWebUrl('git@forge.example:team/group/project.git')).toBe('https://forge.example/team/group/project');
    expect(repositoryWebUrl('ssh://git@forge.example:2222/team/project.git')).toBe('https://forge.example/team/project');
    expect(repositoryWebUrl('https://github.com/team/project.git')).toBe('https://github.com/team/project');
  });
  it('removes credentials and query strings but preserves web ports', () => {
    expect(repositoryWebUrl('https://user:secret@forge.example:8443/team/project.git?token=secret#x')).toBe('https://forge.example:8443/team/project');
  });
  it('does not turn local paths or unsupported schemes into links', () => {
    for (const value of [null, '/local/repo', 'file:///local/repo', 'javascript:alert(1)', 'https://example.com/']) expect(repositoryWebUrl(value)).toBeNull();
  });
});
