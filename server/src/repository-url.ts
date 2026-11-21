/** A browser link from an origin remote. Never expose embedded credentials or SSH ports. */
export function repositoryWebUrl(remote: string | null): string | null {
  if (!remote) return null;
  const raw = remote.trim();
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(raw);
  try {
    const url = new URL(scp ? `ssh://${scp[1]}/${scp[2]}` : raw);
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname) return null;
    const path = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
    if (!path || path === '/') return null;
    const web = new URL(`${url.protocol === 'http:' ? 'http:' : 'https:'}//${url.hostname}`);
    if (['http:', 'https:'].includes(url.protocol)) web.port = url.port;
    web.pathname = path;
    return web.href;
  } catch { return null; }
}
