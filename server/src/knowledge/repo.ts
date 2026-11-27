// Reading a knowledge base out of git (design doc: docs/designs/knowledge.md, "Only what is merged
// is read"). Nothing here looks at the checkout's files: the manifest, the index and every entry
// come from the commit the default branch is at, so a branch somebody has checked out, an
// unmerged proposal or an uncommitted edit never reaches an agent.
import { spawn } from 'node:child_process';
import { git } from '../git.ts';
import {
  entryIdOf, entryPath, KNOWLEDGE_ENTRIES_DIR, KNOWLEDGE_MANIFEST, parseEntry, parseManifest,
  type KnowledgeEntry, type KnowledgeIndexEntry, type KnowledgeManifest,
} from '../shared/knowledge.ts';

export interface SkippedEntry {
  path: string;
  reason: string;
}

/** A knowledge base as it stands at one commit. */
export interface KnowledgeRead {
  /** The ref that was read, such as `origin/main`. */
  ref: string;
  commit: string;
  manifest: KnowledgeManifest;
  index: KnowledgeIndexEntry[];
  /** Files under `entries/` that are not valid entries, with why. They are left out of the index. */
  skipped: SkippedEntry[];
}

const verify = async (repo: string, ref: string): Promise<string> => (await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true })).trim();

/**
 * The ref a knowledge base is read from: the remote's default branch as last fetched, or, for a
 * repository with no remote, its own main branch. Null when there is no commit to read.
 */
export async function knowledgeRef(repo: string): Promise<string | null> {
  const head = (await git(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true })).trim();
  for (const ref of [head, 'origin/main', 'origin/master', 'main', 'master', 'HEAD']) {
    if (ref && (await verify(repo, ref))) return ref;
  }
  return null;
}

/** One file at a ref, or null when it is not there. */
async function fileAt(repo: string, ref: string, path: string): Promise<string | null> {
  const sha = (await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}:${path}`], { allowFail: true })).trim();
  return sha ? git(repo, ['cat-file', 'blob', sha]) : null;
}

/** Many blobs in one git process: `cat-file --batch`, each answer `<sha> <type> <size>\n<bytes>\n`. */
function blobsAt(repo: string, ref: string, paths: readonly string[]): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd: repo, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', reject);
    child.on('close', () => {
      const all = Buffer.concat(chunks);
      const out = new Map<string, string>();
      let at = 0;
      for (const path of paths) {
        const eol = all.indexOf(0x0a, at);
        if (eol < 0) break;
        const head = all.toString('utf8', at, eol).split(' ');
        at = eol + 1;
        if (head[1] !== 'blob') continue; // "<name> missing": no bytes follow
        const size = Number(head[2]);
        out.set(path, all.toString('utf8', at, at + size));
        at += size + 1;
      }
      resolve(out);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(paths.map((p) => `${ref}:${p}\n`).join(''));
  });
}

/** Whether the repository at `repo` is a knowledge base at `ref`: its manifest, why it is not valid, or null for none. */
export async function manifestAt(repo: string, ref: string): Promise<ReturnType<typeof parseManifest> | null> {
  const text = await fileAt(repo, ref, KNOWLEDGE_MANIFEST);
  return text === null ? null : parseManifest(text);
}

/** The whole knowledge base at `ref`, or null when the repository is not one there. Throws nothing for a bad entry: it is skipped, with why. */
export async function readKnowledge(repo: string, ref: string): Promise<KnowledgeRead | null> {
  const commit = await verify(repo, ref);
  if (!commit) return null;
  const manifest = await manifestAt(repo, commit);
  if (!manifest?.ok) return null;
  const listed = (await git(repo, ['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', '-z', commit, '--', `${KNOWLEDGE_ENTRIES_DIR}/`], { allowFail: true })).split('\0').filter((p) => p.endsWith('.md'));
  const blobs = await blobsAt(repo, commit, listed);
  const index: KnowledgeIndexEntry[] = [];
  const skipped: SkippedEntry[] = [];
  for (const path of listed) {
    const parsed = parseEntry(path, blobs.get(path) ?? '');
    if (!parsed.ok) { skipped.push({ path, reason: parsed.reason }); continue; }
    const { body: _body, ...head } = parsed.value;
    index.push(head);
  }
  index.sort((a, b) => a.id.localeCompare(b.id));
  return { ref, commit, manifest: manifest.value, index, skipped };
}

/** One entry with its body, at a commit; null when it is not there or not valid. */
export async function entryAt(repo: string, commit: string, id: string): Promise<KnowledgeEntry | null> {
  const path = entryPath(id);
  if (entryIdOf(path) !== id) return null;
  const text = await fileAt(repo, commit, path);
  if (text === null) return null;
  const parsed = parseEntry(path, text);
  return parsed.ok ? parsed.value : null;
}

/** The ids of the entries whose text holds any of `terms`, at a commit. */
export async function entriesHolding(repo: string, commit: string, terms: readonly string[]): Promise<Set<string>> {
  if (terms.length === 0) return new Set();
  const out = await git(repo, ['-c', 'core.quotePath=false', 'grep', '-l', '-i', '-F', '-z', ...terms.flatMap((t) => ['-e', t]), commit, '--', `${KNOWLEDGE_ENTRIES_DIR}/`], { allowFail: true });
  const ids = out.split('\0').map((hit) => entryIdOf(hit.slice(hit.indexOf(':') + 1)));
  return new Set(ids.filter((id): id is string => id !== null));
}
