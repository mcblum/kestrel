// A fenced (or indented) code block in agent text, its code coloured by its language
// (highlight/HighlightedCode.tsx), with Copy and, for a shell block in a session, Run. The buttons
// sit on a slim row above the code, so they never cover it and are not part of a selection of it.
// Copy copies the plain code, never the coloured spans. Run sends the block to the session's Run terminal (codeRun.ts); while it runs
// its button stops it. Open shows the block whole in a tab of its own (pages/CodePage.tsx): the tab points at
// the block in its message (@kestrel/server/code-ref), so a block with no message to point at has no Open.
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { Pause, Play, SquareArrowOutUpRight } from 'lucide-react';
import { runnableBlock } from '@kestrel/server/code-run';
import { runBlock, stopRun, useBlockRun } from '../codeRun.ts';
import { paneThere } from '@kestrel/server/machines';
import { useMachineName } from '../machines.ts';
import { actions, useApp } from '../store.ts';
import { CopyButton } from './CopyButton.tsx';
import { openView } from '../route.ts';
import { HighlightedCode } from '../highlight/HighlightedCode.tsx';

/** The part of a hast node read here. */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  position?: { start?: { offset?: number } };
  children?: HastNode[];
}

const textOf = (node: HastNode): string => (node.type === 'text' ? (node.value ?? '') : (node.children ?? []).map(textOf).join(''));

/** The code element's language (`language-bash` -> `bash`), or null. */
function languageOf(code: HastNode | undefined): string | null {
  const classes = code?.properties?.className;
  const names = Array.isArray(classes) ? classes.map(String) : [];
  return names.find((name) => name.startsWith('language-'))?.slice('language-'.length) ?? null;
}

type PreProps = ComponentPropsWithoutRef<'pre'> & { node?: HastNode };

/** The message a block is in, so a tab can point at it. */
export interface CodeSource {
  sessionId: string;
  messageId: string;
}

/** Makes the `pre` renderer for a piece of agent text; Run only when a session is known, Open only when its message is. */
export function codeBlockFor(sessionId: string | undefined, messageId?: string) {
  return function CodeBlockPre({ node, children: _children, ...props }: PreProps) {
    const code = node?.children?.find((child) => child.type === 'element' && child.tagName === 'code');
    const text = (code ? textOf(code) : node ? textOf(node) : '').replace(/\n$/, '');
    const lang = languageOf(code);
    const runnable = sessionId ? runnableBlock(lang, text) : null;
    const at = node?.position?.start?.offset;
    const source = sessionId && messageId && at !== undefined ? { sessionId, messageId, at } : undefined;
    return (
      <div className="code-block">
        <CodeHead lang={lang} text={text} source={source}>
          {runnable && sessionId && <RunButton sessionId={sessionId} lang={lang} text={text} script={runnable.script} />}
        </CodeHead>
        <pre {...props}>
          <HighlightedCode lang={lang} code={text} />
        </pre>
      </div>
    );
  };
}

/** Opens the block in a tab of its own: a new tab, so the conversation stays where it is. */
function OpenButton({ source }: { source: CodeSource & { at: number } }) {
  return (
    <button type="button" className="copy-button" aria-label="Open code in a tab" title="Open in a tab" onClick={() => openView({ kind: 'code', ...source }, true)}>
      <SquareArrowOutUpRight aria-hidden />
    </button>
  );
}

/** The slim row above a code block: its language, Copy, Open, and any other buttons. */
function CodeHead({ lang, text, source, children }: { lang: string | null; text: string; source?: CodeSource & { at: number }; children?: ReactNode }) {
  return (
    <div className="code-head">
      {lang && <span className="code-lang">{lang}</span>}
      <span className="code-tools">
        <CopyButton value={text} label="code" />
        {source && <OpenButton source={source} />}
        {children}
      </span>
    </div>
  );
}

/**
 * A fenced block from plain text (the user's own message): the same frame, Copy and Open, no Run of its
 * own. `tools` are more buttons for the head's row, after Copy (Set up this computer's Run).
 */
export function CodeFrame({ lang, code, source, tools }: { lang: string | null; code: string; source?: CodeSource & { at: number }; tools?: ReactNode }) {
  return (
    <div className="code-block">
      <CodeHead lang={lang} text={code} source={source}>
        {tools}
      </CodeHead>
      <pre>
        <HighlightedCode lang={lang} code={code} />
      </pre>
    </div>
  );
}

function RunButton(props: { sessionId: string; lang: string | null; text: string; script: string }) {
  const machine = useMachineName(useApp((s) => s.sessionsById.get(props.sessionId)?.runsOn));
  return machine ? <RunThere machine={machine} /> : <RunHere {...props} />;
}

/** A session on another computer: its Run terminal is there, so Run says so and runs nothing. */
function RunThere({ machine }: { machine: string }) {
  const why = paneThere('terminal', machine);
  return (
    <button type="button" className="copy-button code-run" aria-label={why} aria-disabled title={why} onClick={() => actions.showError(why)}>
      <Play aria-hidden />
    </button>
  );
}

function RunHere({ sessionId, lang, text, script }: { sessionId: string; lang: string | null; text: string; script: string }) {
  const state = useBlockRun(sessionId, script);
  if (state === 'running')
    return (
      <button type="button" className="copy-button code-run is-running" aria-label="Stop the run" onClick={() => stopRun(sessionId)}>
        <Pause aria-hidden />
      </button>
    );
  const busy = state === 'busy';
  return (
    <button
      type="button"
      className="copy-button code-run"
      aria-label={busy ? 'A run is in progress' : 'Run in the session’s Run terminal'}
      aria-disabled={busy || undefined}
      onClick={() => !busy && runBlock(sessionId, { lang, text, script })}
    >
      <Play aria-hidden />
    </button>
  );
}
