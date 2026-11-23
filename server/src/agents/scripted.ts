// A stand-in agent for trying the UI by hand with fake data (KESTREL_FAKE=1 KESTREL_SCRIPTED_AGENT=1):
// no model, no network. Never used by tests (they use test-agent.ts, which has no timers) and never
// chosen for a real store.
//
// What a message does:
// - one containing "/approve" asks for approval of a long, made-up command, with the options
//   Claude Code offers (Allow, Always allow, Deny), and finishes the turn once answered;
// - one containing "/sandbox" asks about a command outside the sandbox, with the "Always allow"
//   choices a Claude child's card offers (scripted-sandbox.ts), and finishes once answered;
// - one containing "/fail" fails the turn;
// - one containing "/shots 12" takes 12 screenshots with a tap between each (scripted-shots.ts);
// - one containing "/approvals 12" asks for 12 approvals in a row, a tool line with each, and
//   "/approvals 12 shots" taps the simulator after each approval and takes a screenshot
//   (scripted-approvals.ts);
// - one naming a ticket id (PROJ-482), or containing "/note", also calls the `suggest` tool first
//   (scripted-suggest.ts), without waiting on the answer;
// - one with files attached first says what it got ("Got 2 attachments: a.png (image), notes.txt
//   (file)"), so attaching can be seen working; SCRIPTED behaviour, not what a model says;
// - one containing "/code" answers with sample code blocks (shell ones that can be run, a
//   console transcript, and code in several languages; scripted-code.ts), so the code block buttons
//   and the highlighting can be tried; "/streamcode" streams a reply with a long code block in it;
// - one containing "/review" hands over a sample review with `post_review`, so its card can be seen
//   (in a review session; any other refuses it);
// - one containing "/edit notes.md" writes (appends a line to) that file in the session's folder,
//   with a Write tool line that names it, so opening a file's diff from the conversation can be tried;
// - one containing "/file plan.md" hands over that file from the session's folder with `send_file`,
//   so a file card, and opening a Markdown or PDF file in a tab of the session, can be tried;
// - one containing "/stream 20" streams a reply for 20 seconds, a few words at a time, the way a
//   model writes, so a long conversation can be watched (and measured) while text streams in;
// - anything else works for a while ("/hold 40" for 40 seconds; 25 by default), saying so every
//   few seconds, so there is time to send messages into the turn and to press Stop. A message sent
//   during such a turn goes in at once (`sendNow`) and is read a moment later: the agent says so in
//   the same turn. One containing "/held" is refused, so Kestrel's held fallback can be tried; Stop
//   before one is read lists it unread, as Claude does.
// A new session's generated title is "Scripted: " and the prompt's first three words.
import { SAMPLE_SLASH_COMMANDS } from '../seed.ts';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathsInside } from './edited-paths.ts';
import type { AgentAdapter, AgentAttachment, AgentEvent, AgentHandle, InputAnswer, KestrelToolHost, MidTurnMessage } from './types.ts';
import { runScriptedSuggestion } from './scripted-suggest.ts';
import { shotsScript } from './scripted-shots.ts';
import { runApprovals } from './scripted-approvals.ts';
import { scriptedRefusals } from './scripted-refusals.ts';
import { scriptedSandboxCard } from './scripted-sandbox.ts';
import { CODE_SAMPLE, STREAMED_CODE_CHARS_PER_TICK, STREAMED_CODE_REPLY } from './scripted-code.ts';

const DEFAULT_HOLD_S = 25;
const TICK_MS = 4000;
/** How long the stand-in takes to read a message sent into its turn. */
const READ_DELAY_MS = 1500;
/** How often "/stream" sends the next piece of text. */
const STREAM_TICK_MS = 50;
const STREAM_WORDS = 'The slow path re-reads the file on every call and throws the result away, so I am caching the parsed result per request and keeping the old behaviour behind a flag for one release. '.split(' ');
/** SAMPLE: a made-up cost for a finished turn, so the Details pane's Usage row has something to show. */
const SAMPLE_TURN_COST_USD = 0.14;

const COMMAND = [
  'pnpm --filter @kestrel/server exec tsx scripts/migrate.ts \\',
  '  --database ./data/kestrel.sqlite \\',
  '  --from 14 --to 15 \\',
  '  --backup ./data/backups/before-15.sqlite \\',
  '  --verbose',
  '# then rebuild the derived tables',
  'sqlite3 ./data/kestrel.sqlite "DELETE FROM session_detail WHERE json IS NULL;"',
  'git -C ./worktrees/demo status --short',
].join('\n');

function handle(emit: (e: AgentEvent) => void, id: string, tools: KestrelToolHost, cwd: string): AgentHandle {
  let busy = false;
  let timers: NodeJS.Timeout[] = [];
  let pending: { requestId: string; then: (optionId: string) => void } | null = null;
  /** The turn running is a plain "/hold" one, which takes messages mid-turn. */
  let holding = false;
  /** Messages sent into the turn and not read yet, by id. */
  let unread: string[] = [];
  const clear = () => {
    timers.forEach(clearTimeout);
    timers = [];
  };
  const say = (text: string) => emit({ type: 'message', id: `m-${randomUUID()}`, text, delta: text, done: true });
  const finish = (event: AgentEvent) => {
    clear();
    pending = null;
    busy = false;
    holding = false;
    if (unread.length > 0) emit({ type: 'unread', ids: unread });
    unread = [];
    // Where the turn ends, as a real agent says it (Fork from an earlier turn needs it).
    emit({ type: 'turn-point', point: `scripted-point-${randomUUID()}` });
    emit(event);
  };
  return {
    agentSessionId: () => id,
    busy: () => busy,
    send(text, attachments) {
      if (busy) throw new Error('A turn is already running.');
      busy = true;
      if (attachments?.length) say(gotAttachments(attachments));
      const first = (text || attachments?.[0]?.name || '').split('\n')[0]!.slice(0, 80);
      void runScriptedSuggestion(text, tools, emit).catch((error) => console.error('[kestrel] scripted suggestion failed', error));
      if (text.includes('/fail')) return void timers.push(setTimeout(() => finish({ type: 'failed', reason: 'The scripted agent was asked to fail.', kind: 'other' }), 500));
      if (text.includes('/sandbox')) {
        const request = scriptedSandboxCard(`req-${randomUUID()}`);
        pending = { requestId: request.id, then: (optionId) => {
          say(optionId === 'deny' ? 'Denied: I did not commit.' : 'Committed (pretend).');
          finish({ type: 'done', reason: 'complete' });
        } };
        emit({ type: 'needs-input', request });
        return;
      }
      if (text.includes('/approve')) {
        const requestId = `req-${randomUUID()}`;
        const options = [
          { id: 'allow', label: 'Allow', role: 'allow' as const },
          { id: 'always', label: 'Always allow migrate.ts in this session', role: 'allow' as const },
          { id: 'deny', label: 'Deny', role: 'deny' as const },
        ];
        const labels = new Map(options.map((o) => [o.id, o.label]));
        pending = {
          requestId,
          then: (optionId) => {
            const label = labels.get(optionId) ?? 'Answered';
            timers.push(
              setTimeout(() => {
                say(optionId === 'deny' ? 'Denied: I did not run it.' : `${label}: the migration ran (pretend).`);
                finish({ type: 'done', reason: 'complete' });
              }, 1500),
            );
          },
        };
        say('I need to run the migration. Asking first.');
        emit({ type: 'needs-input', request: { id: requestId, kind: 'approval', title: 'Run a command', detail: COMMAND, tool: 'Bash', options } });
        return;
      }
      const approvals = /\/approvals\s+(\d+)(\s+shots)?/.exec(text);
      if (approvals) {
        return runApprovals(Number(approvals[1]), Boolean(approvals[2]), {
          emit,
          ask: (request, then) => {
            pending = { requestId: request.id, then };
            emit({ type: 'needs-input', request });
          },
          later: (ms, fn) => void timers.push(setTimeout(fn, ms)),
          finish,
        });
      }
      // SCRIPTED: a refused edit, a failed command and an edit Kestrel could not stop, as their rows show.
      if (text.includes('/refused')) {
        scriptedRefusals().forEach(emit);
        say('The edit to Epsilon was refused: I will delegate it.');
        return void timers.push(setTimeout(() => finish({ type: 'done', reason: 'complete' }), 300));
      }
      const edit = /\/edit\s+(\S+)/.exec(text);
      if (edit) {
        const paths = pathsInside(cwd, [edit[1]!]);
        const tool = `tool-${randomUUID()}`;
        if (paths.length === 0) say(`Not editing ${edit[1]}: it is outside this session's folder.`);
        else {
          emit({ type: 'tool', id: tool, name: 'Write', summary: `Write ${paths[0]}`, status: 'started', paths });
          appendFileSync(join(cwd, paths[0]!), `Scripted line at ${new Date().toISOString()}\n`);
          emit({ type: 'tool', id: tool, name: 'Write', summary: `Write ${paths[0]}`, status: 'finished', paths });
          emit({ type: 'files-changed', paths });
          say(`Wrote ${paths[0]}.`);
        }
        return void timers.push(setTimeout(() => finish({ type: 'done', reason: 'complete' }), 300));
      }
      // SCRIPTED: hands over a file from the session's folder, as an agent does with one it made.
      const sent = /\/file\s+(\S+)/.exec(text);
      if (sent) {
        void tools.sendFile({ path: sent[1]!, caption: 'A file from this session’s folder' });
        return void timers.push(setTimeout(() => finish({ type: 'done', reason: 'complete' }), 300));
      }
      // SCRIPTED: leaves a next step and then goes on writing, as a real agent sometimes does: the box
      // must still show at the end of the turn.
      if (text.includes('/next')) {
        void tools.nextStep({ recap: 'The review is done: tests, lint and builds pass. Nothing has been posted.', ask: 'Do you want these posted as a review comment?', replies: ['Post as a comment', 'No, keep it local'] });
        timers.push(setTimeout(() => say('I found nothing that should block merging. I have one cost concern and a few small notes.'), 400));
        return void timers.push(setTimeout(() => finish({ type: 'done', reason: 'complete' }), 1500));
      }
      // SCRIPTED: hands over a review, as a session reviewing somebody else's pull request ends
      // (refused, with the reason, in any other session).
      // SCRIPTED: "/review clean" hands over an approval with nothing to fix, to see the card's "Approve without comment".
      if (text.includes('/review clean')) {
        void tools.postReview({ verdict: 'approve', summary: 'Makes the table header sticky and reads its offset from the scroll parent, so it holds inside a panel as well as on the page. The new test scrolls the container and checks where the header ends up. I found nothing to change.' });
        return void timers.push(setTimeout(() => finish({ type: 'done', reason: 'complete' }), 400));
      }
      if (text.includes('/review')) {
        // SAMPLE: the files the comments point at, so their code can be opened from the card.
        mkdirSync(join(cwd, 'ui/src'), { recursive: true });
        writeFileSync(join(cwd, 'ui/src/Table.tsx'), SAMPLE_TABLE);
        writeFileSync(join(cwd, 'ui/src/Table.test.tsx'), SAMPLE_TABLE_TEST);
        mkdirSync(join(cwd, dirname(LONG_SAMPLE_PATH)), { recursive: true });
        writeFileSync(join(cwd, LONG_SAMPLE_PATH), 'package com.example.platform.tables;\n\n/** Where a sticky header sits. */\npublic final class StickyHeaderOffsetResolverFactory {}\n');
        void tools.postReview({
          verdict: 'request_changes',
          summary: 'Keeps the table header in view by making it sticky. The approach is right, but it only works when the page itself scrolls, and the new test would not catch that.',
          findings: [
            {
              brief: 'The sticky header covers the first row when the table is inside a scrolling panel.',
              detail: 'The offset in `top: var(--page-header)` assumes the page is what scrolls. Inside a panel with `overflow: auto` the header sticks to the panel, where that offset is too large by the height of the page header.',
              fix: 'Read the offset from the scroll parent, or set `top: 0` when the table is in a panel.',
              priority: 'high',
              blocking: true,
              // SAMPLE: the second is a very long path, to show how one is cut in the middle.
              refs: [{ path: 'ui/src/Table.tsx', line: 42 }, { path: LONG_SAMPLE_PATH, line: 3 }],
            },
            {
              brief: 'The new test checks the class name, not that the header stays put.',
              detail: 'It passes with the bug above. `expect(header).toHaveClass("sticky")` says nothing about where the header is after a scroll.',
              fix: 'Scroll the container and assert the header’s position.',
              priority: 'medium',
              blocking: false,
              refs: [{ path: 'ui/src/Table.test.tsx', line: 18 }],
            },
            { brief: 'The changelog has no entry for this.', priority: 'low', blocking: false },
          ],
        });
        return void timers.push(setTimeout(() => finish({ type: 'done', reason: 'complete' }), 600));
      }
      // SCRIPTED: starts a session in another project, so the row that marks it can be seen where it happened.
      if (text.includes('/delegate')) {
        void tools
          .delegate({ tasks: [{ project: 'Docs', brief: 'Check the README for outdated claims /hold 2' }] })
          .then((result) => say(result.text), (error: unknown) => say(String(error)))
          .then(() => timers.push(setTimeout(() => finish({ type: 'done', reason: 'complete' }), 300)));
        return;
      }
      // Before "/code", which "/streamcode" contains.
      if (text.includes('/streamcode')) {
        const id = `m-${randomUUID()}`;
        const ticks = Math.ceil(STREAMED_CODE_REPLY.length / STREAMED_CODE_CHARS_PER_TICK);
        for (let t = 1; t <= ticks; t++) {
          const written = STREAMED_CODE_REPLY.slice(0, t * STREAMED_CODE_CHARS_PER_TICK);
          const delta = written.slice((t - 1) * STREAMED_CODE_CHARS_PER_TICK);
          timers.push(setTimeout(() => emit({ type: 'message', id, text: written, delta, done: t === ticks }), t * STREAM_TICK_MS));
        }
        return void timers.push(setTimeout(() => finish({ type: 'done', reason: 'complete' }), (ticks + 1) * STREAM_TICK_MS));
      }
      if (text.includes('/code')) {
        say(CODE_SAMPLE);
        return void timers.push(setTimeout(() => finish({ type: 'done', reason: 'complete' }), 300));
      }
      const stream = /\/stream\s+(\d+)/.exec(text);
      if (stream) {
        const id = `m-${randomUUID()}`;
        const ticks = Math.floor((Number(stream[1]) * 1000) / STREAM_TICK_MS);
        let written = '';
        for (let t = 1; t <= ticks; t++)
          timers.push(
            setTimeout(() => {
              const delta = `${STREAM_WORDS[t % STREAM_WORDS.length]}${t % 60 === 0 ? '\n\n' : ' '}`;
              written += delta;
              emit({ type: 'message', id, text: written, delta, done: t === ticks });
            }, t * STREAM_TICK_MS),
          );
        return void timers.push(setTimeout(() => finish({ type: 'done', reason: 'complete' }), (ticks + 1) * STREAM_TICK_MS));
      }
      const shots = /\/shots\s+(\d+)/.exec(text);
      if (shots) {
        const script = shotsScript(Number(shots[1]));
        for (const step of script) timers.push(setTimeout(() => emit(step.event), step.at));
        timers.push(setTimeout(() => finish({ type: 'done', reason: 'complete' }), (script.at(-1)?.at ?? 0) + 300));
        return;
      }
      const seconds = Number(/\/hold\s+(\d+)/.exec(text)?.[1] ?? DEFAULT_HOLD_S);
      holding = true;
      emit({ type: 'status', text: 'Working…' });
      for (let t = TICK_MS; t < seconds * 1000; t += TICK_MS) timers.push(setTimeout(() => say(`Still on "${first}" (${t / 1000}s)…`), t));
      timers.push(
        setTimeout(() => {
          say(`Done with: ${first}`);
          finish({ type: 'done', reason: 'complete', costUsd: SAMPLE_TURN_COST_USD });
        }, seconds * 1000),
      );
    },
    // SCRIPTED: takes a message during a "/hold" turn and reads it a moment later, saying so in the same turn.
    async sendNow(message: MidTurnMessage) {
      if (!busy || !holding || message.text.includes('/held')) return false;
      unread = [...unread, message.id];
      timers.push(
        setTimeout(() => {
          unread = unread.filter((id) => id !== message.id);
          emit({ type: 'picked-up', ids: [message.id] });
          say(`Read your message ("${message.text.split('\n')[0]!.slice(0, 60)}"): taking it into account in this turn.`);
        }, READ_DELAY_MS),
      );
      return true;
    },
    answer(requestId: string, answer: InputAnswer) {
      if (!pending || pending.requestId !== requestId) throw new Error('Nothing is waiting for that answer.');
      const { then } = pending;
      pending = null;
      then(answer.optionId ?? '');
    },
    async stop() {
      if (busy) finish({ type: 'done', reason: 'stopped' });
    },
  };
}

/** SCRIPTED: what the stand-in says it received, e.g. "Got 2 attachments: a.png (image), notes.txt (file)". */
export function gotAttachments(files: readonly AgentAttachment[]): string {
  return `Got ${files.length} attachment${files.length === 1 ? '' : 's'}: ${files.map((f) => `${f.name} (${f.kind})`).join(', ')}`;
}

/** The scripted title: no model, "Scripted: " and the prompt's first three words, so the rename can be seen. */
export const scriptedTitle = async (prompt: string): Promise<string> => `Scripted: ${prompt.trim().split(/\s+/).slice(0, 3).join(' ')}`;

export function scriptedAdapter(): AgentAdapter {
  return {
    agent: 'claude',
    models: async () => ({ models: [{ id: '', label: 'Default' }, { id: 'scripted-big', label: 'Scripted (big)' }], fromSdk: false }),
    // SAMPLE: so the new-session box has a list to offer on "/" without a real agent.
    slashCommands: async () => [...SAMPLE_SLASH_COMMANDS],
    start(options, prompt, emit, attachments) {
      const id = `scripted-${randomUUID()}`;
      emit({ type: 'started', agentSessionId: id, model: 'scripted', kestrelTools: 'connected', missing: [] });
      const h = handle(emit, id, options.tools, options.directory);
      h.send(prompt, attachments);
      return h;
    },
    resume(agentSessionId, options, emit) {
      return handle(emit, agentSessionId, options.tools, options.directory);
    },
    // A scripted conversation keeps nothing between turns, so a fork is a new id that resumes as any does.
    fork: async () => `scripted-${randomUUID()}`,
  };
}

// SAMPLE: the files the scripted review's comments point at ("/review").
const LONG_SAMPLE_PATH = 'libs/platform-model/platform-model/src/main/java/com/example/platform/model/tables/service/layout/StickyHeaderOffsetResolverFactory.java';
const SAMPLE_TABLE = "import { useRef, type ReactNode } from 'react';\n\ninterface Column<T> {\n  key: keyof T & string;\n  title: string;\n  render?: (row: T) => ReactNode;\n}\n\ninterface Props<T> {\n  rows: readonly T[];\n  columns: readonly Column<T>[];\n  /** Keep the header in view while the rows scroll. */\n  stickyHeader?: boolean;\n}\n\nconst HEADER_HEIGHT = 36;\nconst PAGE_OFFSET = 56;\n\nfunction cell<T>(row: T, column: Column<T>): ReactNode {\n  return column.render ? column.render(row) : String(row[column.key] ?? '');\n}\n\nexport function Table<T extends { id: string }>({ rows, columns, stickyHeader = false }: Props<T>) {\n  const body = useRef<HTMLTableSectionElement>(null);\n  const empty = rows.length === 0;\n\n  if (empty) {\n    return <p className=\"table-empty\">Nothing to show.</p>;\n  }\n\n  return (\n    <table className=\"table\">\n      <thead\n        className={stickyHeader ? 'table-head sticky' : 'table-head'}\n        style={\n          stickyHeader\n            ? {\n                position: 'sticky',\n                height: HEADER_HEIGHT,\n                // Sits under the app bar.\n                zIndex: 2,\n                top: PAGE_OFFSET,\n              }\n            : undefined\n        }\n      >\n        <tr>\n          {columns.map((column) => (\n            <th key={column.key}>{column.title}</th>\n          ))}\n        </tr>\n      </thead>\n      <tbody ref={body}>\n        {rows.map((row) => (\n          <tr key={row.id}>\n            {columns.map((column) => (\n              <td key={column.key}>{cell(row, column)}</td>\n            ))}\n          </tr>\n        ))}\n      </tbody>\n    </table>\n  );\n}\n";
const SAMPLE_TABLE_TEST = "import { render, screen } from '@testing-library/react';\nimport { describe, expect, it } from 'vitest';\nimport { Table } from './Table';\n\nconst rows = [\n  { id: '1', name: 'Ada' },\n  { id: '2', name: 'Grace' },\n];\nconst columns = [{ key: 'name' as const, title: 'Name' }];\n\ndescribe('Table', () => {\n  it('lists its rows', () => {\n    render(<Table rows={rows} columns={columns} />);\n    expect(screen.getByText('Grace')).toBeTruthy();\n  });\n\n  it('keeps the header in view', () => {\n    const { container } = render(<Table rows={rows} columns={columns} stickyHeader />);\n    expect(container.querySelector('thead')?.className).toContain('sticky');\n  });\n});\n";
