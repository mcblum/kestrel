// The pieces of the Details pane. One layout rule, so it does not drift again:
//
//   1. A section is a quiet label and its lines. No cards, no badges, no divider lines.
//   2. A line is one of two kinds, and never anything in between:
//      - a LINE across the whole pane, with no label, for an identity or a state that says itself
//        ("cdo-modules", the branch, "Working tree clean", a folder). Its actions sit at the right.
//      - a FACT: a label in a narrow column on the left and a short value beside it, every fact in
//        the section on the same columns and the same spacing (Session).
//   3. Every line is one line. A value that can be long (a branch, a path, a base) is cut in the
//      middle to fit, start and end kept (MiddleText), with the whole value in its tooltip and a
//      Copy action that copies the whole value; never wrapped into a paragraph, never moved under
//      its label. A sentence that can be long (an "unavailable" reason, a PR title) ends in an
//      ellipsis with the whole of it in the tooltip.
//
// A value from a source shows "Loading…" or "Unavailable · reason" until it is ready, never zero
// or blank.
import type { ReactNode } from 'react';
import type { Sourced } from '@kestrel/server/sourced';
import { needsRestart } from './useSourced.ts';

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="details-section" aria-label={title}>
      <h3 className="details-head">{title}</h3>
      <div className="details-lines">{children}</div>
    </section>
  );
}

interface LineProps {
  children: ReactNode;
  /** Buttons at the right, shown on hover or keyboard focus. */
  actions?: ReactNode;
  /** Muted: secondary, or saying something is absent. */
  quiet?: boolean;
  /** Starts a new group within the section: a little more space above. */
  group?: boolean;
  /** The whole text, for a line whose text is cut with an ellipsis. */
  tip?: string;
}

/** A line across the whole pane (rule 2, first kind). */
export function Line({ children, actions, quiet, group, tip }: LineProps) {
  const className = ['details-line', quiet && 'details-quiet', group && 'details-group'].filter(Boolean).join(' ');
  return (
    <div className={className}>
      <span className="details-line-value" title={tip}>
        {children}
      </span>
      {actions && <span className="details-actions">{actions}</span>}
    </div>
  );
}

/** Aligned label/value facts (rule 2, second kind): one shared label column, as narrow as the longest label. */
export function Facts({ children }: { children: ReactNode }) {
  return <dl className="details-facts">{children}</dl>;
}

export function Row({ label, children, group = false }: { label: string; children: ReactNode; group?: boolean }) {
  return (
    <div className={`details-row${group ? ' details-fact-group' : ''}`}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

type NotReadyValue = Exclude<Sourced<unknown>, { state: 'ready' }>;

/**
 * What a source that is not ready says, as plain text: `what` names it when the line has no label
 * ("Pull request unavailable · …"). A restart is said once at the top of the pane, so not again here.
 */
export function notReadyText(value: NotReadyValue, what?: { loading: string; unavailable: string }): string {
  if (value.state === 'loading') return what?.loading ?? 'Loading…';
  const head = what?.unavailable ?? 'Unavailable';
  return needsRestart(value) ? head : `${head} · ${value.reason}`;
}

/** A not-ready source in a fact's value: one quiet line, the whole reason on hover. */
export function NotReady({ value }: { value: NotReadyValue }) {
  const text = notReadyText(value);
  return (
    <span className="details-quiet details-clip" title={text}>
      {text}
    </span>
  );
}

/** A source's value once ready; until then, what state it is in. */
export function SourcedValue<T>({ value, children }: { value: Sourced<T>; children: (ready: T) => ReactNode }) {
  if (value.state !== 'ready') return <NotReady value={value} />;
  return <>{children(value.value)}</>;
}
