// Where each finding of a pull-request review goes when it is posted (Matt, 2026-11-24: "if they
// have specific files / line numbers, I'd like it to post on those"). A host takes a comment only on
// a line that is part of the request's diff, so Kestrel reads that diff once, from the commit that
// was reviewed, when the review is handed over, and keeps which lines can take a comment (the
// anchors) on the card. One function (`placeFinding`) then decides, for the card before posting and
// for the posting itself alike, whether a finding goes on the code or stays in the summary, and why.
// Nothing is decided by trying and failing. Pure and browser-safe.
import type { Finding, FindingRef } from './findings.ts';

/**
 * A stretch of lines of one hunk as the request leaves the file: `[first line, how many, the first
 * one's line in the old file or 0 when they were added, which hunk]`. Context lines map to the old
 * file one for one; added lines have none.
 */
export type AnchorRun = [start: number, count: number, oldStart: number, hunk: number];

export interface AnchorFile {
  /** The path before the change, when the file was renamed. */
  old?: string;
  runs: AnchorRun[];
}

/** The lines of a request's diff a comment can be put on, by file. */
export interface DiffAnchors {
  files: Record<string, AnchorFile>;
}

/** The most lines a range may span; a longer one is put on its first line. */
export const RANGE_MAX = 200;

const unquote = (path: string): string => path.replace(/^"(.*)"$/, '$1');

/** A unified diff (`git diff -U3`) read into its anchors. Deleted and binary files have none. */
export function anchorsFromDiff(diff: string): DiffAnchors {
  const files: Record<string, AnchorFile> = {};
  let current: AnchorFile | null = null;
  let oldPath: string | null = null;
  let hunk = -1;
  let next = 0;
  let nextOld = 0;
  const push = (added: boolean) => {
    const runs = current!.runs;
    const last = runs.at(-1);
    const fits = last && last[3] === hunk && last[0] + last[1] === next && (added ? last[2] === 0 : last[2] !== 0 && last[2] + last[1] === nextOld);
    if (fits) last[1] += 1;
    else runs.push([next, 1, added ? 0 : nextOld, hunk]);
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = null;
      oldPath = null;
      continue;
    }
    if (line.startsWith('--- ')) {
      oldPath = line === '--- /dev/null' ? null : unquote(line.slice(4)).replace(/^a\//, '');
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (line === '+++ /dev/null') continue;
      const path = unquote(line.slice(4)).replace(/^b\//, '');
      current = { ...(oldPath && oldPath !== path ? { old: oldPath } : {}), runs: [] };
      files[path] = current;
      continue;
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header && current) {
      hunk += 1;
      nextOld = Number(header[1]);
      next = Number(header[2]);
      continue;
    }
    if (!current || hunk < 0) continue;
    if (line.startsWith('+')) {
      push(true);
      next += 1;
    } else if (line.startsWith('-')) nextOld += 1;
    else if (line.startsWith(' ')) {
      push(false);
      next += 1;
      nextOld += 1;
    }
  }
  return { files };
}

/** A line of the request's diff: where it is in the new file, its hunk, and its old line when it was there before. */
export interface Anchor {
  line: number;
  hunk: number;
  /** Absent: the line was added. */
  oldLine?: number;
}

export function anchorOf(anchors: DiffAnchors, path: string, line: number): Anchor | null {
  const run = anchors.files[path]?.runs.find(([start, count]) => line >= start && line < start + count);
  if (!run) return null;
  const [start, , oldStart, hunk] = run;
  return { line, hunk, ...(oldStart ? { oldLine: oldStart + (line - start) } : {}) };
}

/** Where one finding goes. */
export type Placement =
  | {
      where: 'code';
      ref: FindingRef;
      /** The comment's first line, for a range the host is given whole; absent for one line. */
      start?: number;
      /** The line the comment is on (the last of a range). */
      line: number;
      /** The line in the old file, for a line that was there before (GitLab asks for both). */
      oldLine?: number;
      /** The path before the change, when the file was renamed. */
      oldPath?: string;
      /** True when Kestrel could not read the diff and the host decides. */
      unchecked?: true;
    }
  | { where: 'summary'; reason: string };

const NO_LINE = 'it names no line of code';

/** Where one reference could go on the code, or why not. */
function placeRef(ref: FindingRef, anchors: DiffAnchors): Placement {
  const file = anchors.files[ref.path];
  if (!file) return { where: 'summary', reason: `${ref.path} is not part of this pull request` };
  const first = anchorOf(anchors, ref.path, ref.line);
  if (!first) return { where: 'summary', reason: `${ref.path}:${ref.line} is not part of this pull request's changes` };
  const oldPath = file.old ? { oldPath: file.old } : {};
  // A range goes up whole when all of it is in the same hunk of the diff; otherwise on its first line.
  const end = ref.end !== undefined && ref.end > ref.line && ref.end - ref.line <= RANGE_MAX ? anchorOf(anchors, ref.path, ref.end) : null;
  if (end && end.hunk === first.hunk) return { where: 'code', ref, start: ref.line, line: end.line, ...(end.oldLine ? { oldLine: end.oldLine } : {}), ...oldPath };
  return { where: 'code', ref, line: first.line, ...(first.oldLine ? { oldLine: first.oldLine } : {}), ...oldPath };
}

/**
 * Where a finding goes when the review is posted: on the first of its lines that is part of the
 * request's diff, or in the summary with the reason. Without anchors (the diff could not be read)
 * it goes on its first line and the host decides.
 */
export function placeFinding(f: Pick<Finding, 'refs'>, anchors: DiffAnchors | undefined): Placement {
  const [first] = f.refs;
  if (!first) return { where: 'summary', reason: NO_LINE };
  if (!anchors) return { where: 'code', ref: first, line: first.end ?? first.line, ...(first.end && first.end > first.line ? { start: first.line } : {}), unchecked: true };
  let reason = '';
  for (const ref of f.refs) {
    const placed = placeRef(ref, anchors);
    if (placed.where === 'code') return placed;
    reason ||= placed.reason;
  }
  return { where: 'summary', reason };
}

/** "a.ts:4" or "a.ts:4–9": a reference in words. */
export const refText = (ref: FindingRef): string => `${ref.path}:${ref.line}${ref.end && ref.end > ref.line ? `–${ref.end}` : ''}`;

/** What the card says of a placement before it is posted. */
export function placementText(p: Placement): string {
  if (p.where === 'summary') return `In the summary, because ${p.reason}.`;
  const at = p.start !== undefined ? `${p.ref.path}:${p.start}–${p.line}` : `${p.ref.path}:${p.line}`;
  return p.unchecked ? `On the code at ${at}, if the host takes it there.` : `On the code at ${at}.`;
}
