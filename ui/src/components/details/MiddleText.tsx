// A long value cut in the middle to fit its line, start and end kept ("kestrel/please-re-rev…g-ab07f9cf").
// Pure CSS, so it follows the pane's width as it is resized with no measuring and no timers: the
// value is split once into a head and a tail (shared/details.ts `middleSplit`); the head shrinks and
// ends in an ellipsis, the tail gives way only in a line too narrow for both (styles/details.css).
// Both halves are in the DOM, so selecting the value and copying it copies the whole of it. The
// whole value is the tooltip.
import type { ClipboardEvent } from 'react';
import { middleSplit } from '@kestrel/server/details';

/** Characters kept at the end of a branch name, and at most of a path's last segment. */
export const BRANCH_TAIL = 10;
export const PATH_TAIL = 28;

/**
 * The two halves are flex items, which the browser copies as two lines. A selection inside one
 * value is copied as the one line it is (a branch or a path never holds a line break).
 */
function copyAsOneLine(event: ClipboardEvent<HTMLSpanElement>) {
  const selection = window.getSelection();
  if (!selection || !event.currentTarget.contains(selection.anchorNode) || !event.currentTarget.contains(selection.focusNode)) return;
  event.preventDefault();
  event.clipboardData.setData('text/plain', selection.toString().replace(/\n/g, ''));
}

interface Props {
  text: string;
  /** What `text` stands for, when it is shown shortened (a home path as "~/…"): the tooltip says this. */
  full?: string;
  maxTail: number;
  mono?: boolean;
}

export function MiddleText({ text, full, maxTail, mono }: Props) {
  const { head, tail } = middleSplit(text, maxTail);
  return (
    <span className={mono ? 'middle details-mono' : 'middle'} title={full ?? text} onCopy={copyAsOneLine}>
      <span className="middle-head">{head}</span>
      {tail && (
        <span className="middle-tail">
          <bdi>{tail}</bdi>
        </span>
      )}
    </span>
  );
}
