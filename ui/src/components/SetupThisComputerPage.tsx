// Settings → Connections → Kestrel Connect → Set up this computer (`#/settings/connections/setup`;
// docs/designs/onboarding.md, sections 3, 7 and 18): a page in the main canvas, never a panel from the
// side. Each section starts with a summary and its commands in a terminal block that copies and runs,
// as a chat's code block does. Its disclosure reveals the steps, each with its own command block. Sections with nothing left fold under Already
// here; dismissed lines under Dismissed. Everything a line or card says comes from the server's list
// and the pure functions over it (setup-list.ts, setup-sections.ts): this page only draws it.
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Ban, Check, ChevronRight, Circle, CircleAlert, Clock, KeyRound, LoaderCircle, MessageSquare, Play, RefreshCw, RotateCcw, X } from 'lucide-react';
import { missingText, SETUP_GROUPS, setupActLabel, setupLeft, setupToDo, type SetupItems, type SetupLine, type SetupList } from '@kestrel/server/setup-list';
import { itemId, itemsDismissable, sectionActLabel, setupSectionOf, type SetupRunState, type SetupRuns, type SetupSection } from '@kestrel/server/setup-sections';
import { useResource } from '../data/resources.ts';
import { platform, thisComputer } from '../platform.ts';
import { askAgentOf, askAgentText } from '@kestrel/server/setup-agent';
import { tabActions } from '../tabsStore.ts';
import { opener, openView } from '../route.ts';
import { asSetupList, SETUP_PATH } from '../setupList.ts';
import { setupSteps, useSetupRuns } from '../setupSteps.ts';
import { missingNote } from '@kestrel/server/setup-values';
import { CopyValuesButtons } from './SetupValueRequests.tsx';
import { CodeFrame } from './CodeBlock.tsx';
import { CopyButton } from './CopyButton.tsx';
import { SettingHeading } from './SettingHelp.tsx';
import { SignIn } from './SignIn.tsx';
import { useAgentStatus } from './useAgents.ts';

const backToConnections = opener((newTab) => openView({ kind: 'settings', section: 'connections' }, newTab));

const when = (at: number) => {
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString() ? `today at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

const langOf = (shell: 'sh' | 'powershell') => (shell === 'powershell' ? 'powershell' : 'bash');

/** What a line that stands for many holds: how many are here, and the names, folded; a skill can be dismissed on its own. */
function Items({ line, items }: { line: SetupLine; items: SetupItems }) {
  const one = itemsDismissable(line);
  return (
    <>
      {items.progress && <span className="settings-help">{items.progress}</span>}
      <details className="setup-items">
        <summary>Show {items.names.length === 1 ? 'the name' : `all ${items.names.length} names`}</summary>
        <ul>
          {items.names.map((n) => (
            <li key={n.name} className={n.done ? 'is-done' : undefined}>
              <code>{n.name}</code>
              {n.done && <span className="setup-items-here"> already here</span>}
              {one && !n.done && (
                <button type="button" className="link-button setup-item-dismiss" onClick={() => void setupSteps.dismiss([itemId(line.id, n.name)], true, n.name)}>
                  Not this one
                </button>
              )}
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

/** The mark at a line's start: its run if there is one, else whether its check says it is done. */
function Mark({ line, run }: { line: SetupLine; run: SetupRunState | undefined }) {
  if (line.done) return <Check className="setup-line-mark" aria-label="Done here" />;
  // Not a step to take: it stays where it is, and its line says why.
  if (line.kind === 'cannot') return <Ban className="setup-line-mark" aria-label="Cannot be brought over" />;
  if (run?.state === 'running') return <LoaderCircle className="setup-line-mark is-running" aria-label="Running" />;
  if (run?.state === 'failed') return <CircleAlert className="setup-line-mark is-failed" aria-label="Failed" />;
  if (run?.state === 'waiting') return <Clock className="setup-line-mark" aria-label="Waiting" />;
  return <Circle className="setup-line-mark" aria-label="Not done here" />;
}

/** What a running or finished command printed: the end of it, as a terminal would show. */
function RunOutput({ output }: { output: string | undefined }) {
  return output ? <pre className="setup-line-output" aria-label="Output">{output}</pre> : null;
}

/** How a run stands, in words, under the line; with what its command printed, and a sign-in's code to copy. */
function RunResult({ run }: { run: SetupRunState | undefined }) {
  if (!run) return null;
  if (run.state === 'running')
    return (
      <>
        <span className="settings-help" role="status">Running…</span>
        <RunOutput output={run.output} />
      </>
    );
  if (run.state === 'done')
    return (
      <>
        <span className="settings-help" role="status">{run.said}</span>
        <RunOutput output={run.output} />
      </>
    );
  if (run.state === 'waiting') {
    // A sign-in waiting on its one-time code: the code to copy and the page to open, where they cannot be missed.
    if (run.code)
      return (
        <div className="setup-line-needs setup-line-code" role="status">
          <KeyRound aria-hidden />
          <span>
            <strong>Enter this code to sign in</strong>
            <span className="setup-code-row">
              <code className="setup-code">{run.code}</code>
              <CopyButton value={run.code} label="code" />
              {run.url && (
                <a className="secondary-button small" href={run.url} target="_blank" rel="noreferrer">
                  <ArrowRight aria-hidden /> Open {hostOf(run.url)}
                </a>
              )}
            </span>
            <span className="setup-line-needs-note">This step finishes by itself once you have signed in there.</span>
          </span>
        </div>
      );
    return (
      <>
        <span className="settings-help" role="status">Waiting on {run.on}.</span>
        <RunOutput output={run.output} />
      </>
    );
  }
  return (
    <div className="setup-line-failed" role="alert">
      <span className="settings-help">Failed: {run.reason}</span>
      {run.output && <pre className="setup-line-output">{run.output}</pre>}
    </div>
  );
}

/** The host of an address, for a button's words. */
const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return 'the page';
  }
};

/** Whether a line signs in with a token typed here (a `glab` host with no browser sign-in). */
const takesToken = (line: SetupLine): boolean => line.action?.kind === 'host-sign-in' && !line.action.web && !line.done && !line.dismissed;

/** GitLab's page for making a token, with a name and the scopes `glab` needs filled in. */
const tokenPage = (host: string, name: string): string => `https://${host}/-/user_settings/personal_access_tokens?name=${encodeURIComponent(`glab on ${name}`)}&scopes=api,write_repository`;

/**
 * A `glab` token for a host with no browser sign-in: one field with its own label, where to make the
 * token, and a button that says what it does. The token goes to `glab` once, the field is cleared, and
 * Kestrel keeps it nowhere (18.2).
 */
function TokenRun({ line, list, run }: { line: SetupLine; list: SetupList; run: SetupRunState | undefined }) {
  const id = useId();
  const [token, setToken] = useState('');
  if (line.action?.kind !== 'host-sign-in') return null;
  const host = line.action.host;
  const busy = run?.state === 'running';
  return (
    <form
      className="setup-token"
      onSubmit={(e) => {
        e.preventDefault();
        const value = token.trim();
        setToken('');
        if (value) void setupSteps.runLine(line.id, { token: value });
      }}
    >
      <label htmlFor={id} className="setup-token-label">
        Personal access token for {host}
      </label>
      <span className="settings-help">
        <a href={tokenPage(host, list.here.name)} target="_blank" rel="noreferrer">
          Make one on {host}
        </a>{' '}
        with the api and write_repository scopes, then paste it here.
      </span>
      <div className="setup-token-row">
        <input id={id} className="form-control" type="password" autoComplete="off" spellCheck={false} placeholder="glpat-…" value={token} onChange={(e) => setToken(e.target.value)} />
        <button type="submit" className="secondary-button small" disabled={busy || token.trim() === ''}>
          {busy ? <LoaderCircle className="is-running" aria-hidden /> : <Play aria-hidden />} {busy ? 'Signing in…' : 'Sign in with this token'}
        </button>
      </div>
      <span className="settings-help">It is handed to glab once and kept nowhere by Kestrel.</span>
    </form>
  );
}

/** Whether a click's work is still under way: true from the click until what it started has answered. */
function useWorking(): [boolean, (work: () => Promise<unknown>) => void] {
  const [working, setWorking] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  const start = (work: () => Promise<unknown>) => {
    setWorking(true);
    void work()
      .catch(() => undefined)
      .finally(() => alive.current && setWorking(false));
  };
  return [working, start];
}

/**
 * A button of this page (Matt, 2026-11-26: "the button can't click and do nothing"). From the click until its
 * work has answered it is disabled, turns its icon into a spinner and says what it is doing; `busy` holds it
 * the same way while the server says the step is running (a section's run, another window).
 */
function ActButton({ icon, label, working = 'Working…', busy = false, onAct, ...rest }: { icon: ReactNode; label: string; working?: string; busy?: boolean; onAct: () => Promise<unknown> } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'type' | 'children'>) {
  const [clicked, start] = useWorking();
  const on = clicked || busy;
  return (
    <button type="button" className="secondary-button small" {...rest} disabled={on || rest.disabled} aria-busy={on} onClick={() => start(onAct)}>
      {on ? <LoaderCircle className="is-running" aria-hidden /> : icon} {on ? working : label}
    </button>
  );
}

/** Run, on a command's own block, where a chat's code block has it: a small button after Copy. */
function BlockRun({ label, busy, onRun }: { label: string; busy: boolean; onRun: () => Promise<unknown> }) {
  const [clicked, start] = useWorking();
  const on = clicked || busy;
  return (
    <button type="button" className={`copy-button code-run${on ? ' is-running' : ''}`} aria-label={on ? `${label}: working` : label} title={on ? 'Working…' : label} aria-busy={on} disabled={on} onClick={() => start(onRun)}>
      {on ? <LoaderCircle className="is-running" aria-hidden /> : <Play aria-hidden />}
    </button>
  );
}

/** Whether a line's action is a plain Run, which its command's block then carries: not a sign-in, a token field, a choice or a page to open. */
function runsFromBlock(line: SetupLine, run: SetupRunState | undefined): boolean {
  if (!line.command || !line.action || line.done || line.dismissed || line.run === 'paste' || line.run === 'open') return false;
  if (run?.state === 'waiting' && run.ask === 'replace-or-keep') return false;
  if (line.action.kind === 'sign-in') return false;
  return !(line.action.kind === 'host-sign-in' && !line.action.web);
}

/** What a line offers to do: its own sign-in, a token field, Run or Open; nothing for a line Kestrel cannot run. */
function LineAction({ line, list, run }: { line: SetupLine; list: SetupList; run: SetupRunState | undefined }) {
  if (line.done || line.dismissed) return null;
  if (line.page && !line.action)
    return (
      <div>
        <a className="secondary-button small" href={line.page}>
          <ArrowRight aria-hidden /> Enter its values
        </a>
      </div>
    );
  if (!line.action || line.run === 'paste') return null;
  if (run?.state === 'waiting' && run.ask === 'replace-or-keep')
    return (
      <div className="setup-line-actions">
        <ActButton icon={null} label="Replace" working="Replacing…" onAct={() => setupSteps.runLine(line.id, { differ: 'replace' })} />
        <ActButton icon={null} label="Keep yours" working="Keeping yours…" onAct={() => setupSteps.runLine(line.id, { differ: 'keep' })} />
      </div>
    );
  const busy = run?.state === 'running';
  const unmet = line.needs.filter((id) => list.lines.some((l) => l.id === id && !l.done));
  if (line.action.kind === 'sign-in') return unmet.length === 0 ? <SignIn agent={line.action.agent} small /> : null;
  // A token is typed in a block of its own, above these buttons (TokenRun).
  if (line.action.kind === 'host-sign-in' && !line.action.web) return null;
  // What it does, in words: Run only where there is a command to run (setupActLabel).
  const says = setupActLabel(line);
  const label = run?.state === 'failed' && says === 'Run' ? 'Run again' : run?.state === 'failed' ? 'Try again' : says;
  // Its command's block carries Run; only a link to its Settings page is left to offer here.
  const onBlock = runsFromBlock(line, run);
  // Its missing-values row already offers the one thing to do (copy them, which adds the step first): a second
  // button here that brings the step without its values would be the same click said twice.
  const copies = line.secrets.length > 0 && !!line.copy?.offers.some((o) => !o.older);
  if ((onBlock || copies) && !line.page) return null;
  return (
    <div className="setup-line-actions">
      {!onBlock && !copies && (
        <ActButton icon={<Play aria-hidden />} label={label} busy={busy} onAct={() => setupSteps.runLine(line.id)} />
      )}
      {line.page && (
        <a className="secondary-button small" href={line.page}>
          <ArrowRight aria-hidden /> In Settings
        </a>
      )}
    </div>
  );
}

function Line({ line, list, runs }: { line: SetupLine; list: SetupList; runs: SetupRuns }) {
  const run = runs[line.id];
  const unmet = line.needs.flatMap((id) => list.lines.filter((l) => l.id === id && !l.done));
  return (
    <li className={`setup-line${line.done ? ' is-done' : ''}`}>
      <Mark line={line} run={run} />
      <div className="setup-line-detail">
        <div className="setup-line-heading">
          <span className="setup-line-title">{line.title}</span>
        </div>
        <span className="settings-help">{line.does}</span>
        {/* What stands between this step and done, said where it is seen: a step to do first, or values to type here. */}
        {unmet.length > 0 && !line.done && (
          <p className="setup-line-needs">
            <Clock aria-hidden />
            <span>
              <strong>Do first</strong>
              <span className="setup-line-needs-list">{unmet.map((l) => `${l.title}${l.dismissed ? ' (you dismissed it)' : ''}`).join(', ')}</span>
            </span>
          </p>
        )}
        {line.secrets.length > 0 && !line.done && !takesToken(line) && (
          <div className="setup-line-needs">
            <KeyRound aria-hidden />
            <span>
              <strong>{missingText(line.secrets)}</strong>
              <span className="setup-line-needs-list">
                {line.secrets.map((s, i) => (
                  <span key={s}>
                    {i > 0 && ', '}
                    <code>{s}</code>
                  </span>
                ))}
              </span>
              <span className="setup-line-needs-note">{missingNote(line.copy, line.secrets.length)}</span>
              {line.copy && !line.dismissed && <CopyValuesButtons line={line.id} copy={line.copy} />}
            </span>
          </div>
        )}
        {line.items && <Items line={line} items={line.items} />}
        {line.command && !line.done && (
          <div className="setup-command">
            <CodeFrame
              lang={langOf(line.command.shell)}
              code={line.command.text}
              tools={runsFromBlock(line, run) && <BlockRun label={run?.state === 'failed' ? `Run ${line.title} again` : `Run ${line.title}`} busy={run?.state === 'running'} onRun={() => setupSteps.runLine(line.id)} />}
            />
          </div>
        )}
        {takesToken(line) && <TokenRun line={line} list={list} run={run} />}
        {/* A step that takes a token says what it waits on in its own field, not in a line about itself. */}
        <RunResult run={takesToken(line) && run?.state === 'waiting' && !run.ask ? undefined : run} />
        {/* Every step runs on this computer. Which of several other computers has it is worth saying; with one, it is the page's own heading. */}
        {list.others.length > 1 && <span className="setup-line-from">From {line.from.join(' and ')}</span>}
        <div className="setup-line-actions">
          <LineAction line={line} list={list} run={run} />
          {askAgentOf(line, run) && (
            <button type="button" className="secondary-button small" onClick={() => tabActions.openSetupAsk(askAgentText(line, list, run, platform()))}>
              <MessageSquare aria-hidden /> Ask the agent
            </button>
          )}
          {line.dismissed ? (
            <ActButton icon={<RotateCcw aria-hidden />} label="Restore" working="Restoring…" onAct={() => setupSteps.dismiss([line.id], false, line.title)} />
          ) : (
            !line.done && (
              <ActButton icon={<X aria-hidden />} label="Dismiss" working="Dismissing…" onAct={() => setupSteps.dismiss([line.id], true, line.title)} />
            )
          )}
        </div>
      </div>
    </li>
  );
}

function SectionCard({ section, list, runs }: { section: SetupSection; list: SetupList; runs: SetupRuns }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const lines = list.lines.filter((l) => l.group === section.group && !l.dismissed);
  const toDo = lines.filter(setupToDo);
  const here = lines.filter((l) => !setupToDo(l));
  const busy = lines.some((l) => runs[l.id]?.state === 'running');
  /**
   * One click runs the section and opens it, so what each step is doing shows at once. A section of one step
   * runs that step as its own button would: the click is the person's go-ahead for it (the knowledge base).
   */
  const runSection = (): Promise<unknown> => {
    setOpen(true);
    return toDo.length === 1 ? setupSteps.runLine(toDo[0]!.id) : setupSteps.runSection(section.group);
  };
  const steps = toDo.length === 1 ? '1 step' : `${toDo.length} steps`;
  return (
    <section className="setup-group" aria-labelledby={`${id}-title`}>
      <div className="setup-group-header">
        <h2 className="setup-group-heading">
          <button
            type="button"
            className="setup-group-toggle"
            aria-expanded={open}
            aria-controls={`${id}-steps`}
            aria-labelledby={`${id}-title`}
            aria-describedby={`${id}-status ${id}-summary`}
            onClick={() => setOpen(!open)}
          >
            <ChevronRight aria-hidden />
            <span className="setup-group-overview">
              <span className="setup-group-title">
                <span id={`${id}-title`}>{section.title}</span>
                <span id={`${id}-status`} className="settings-status">{section.finished ? 'Done' : `${section.left} to do`}</span>
              </span>
              <span id={`${id}-summary`} className="settings-help">{section.summary}</span>
            </span>
          </button>
        </h2>
        {/* A section with no one command (MCP servers, files) has only Run to offer. */}
        {!section.finished && !section.command && (
          <div className="setup-group-actions">
            <ActButton
              icon={<Play aria-hidden />}
              label={sectionActLabel(section.group, list.others.map((o) => o.name))}
              working={`Working on ${steps}…`}
              busy={busy}
              title="Runs what each step needs first, and pauses a step that needs you."
              onAct={runSection}
            />
          </div>
        )}
      </div>
      {!section.finished && section.command && (
        <div className="setup-command setup-group-command">
          <CodeFrame
            lang={langOf(section.command.shell)}
            code={section.command.text}
            tools={<BlockRun label={`Run ${section.title}`} busy={busy} onRun={runSection} />}
          />
          {section.uncovered.length > 0 && <p className="settings-help setup-group-uncovered">No command for {section.uncovered.join(', ')}: open {section.title} for {section.uncovered.length === 1 ? 'it' : 'those'}.</p>}
        </div>
      )}
      <div id={`${id}-steps`} className="setup-group-steps" hidden={!open}>
        {open && (
          <>
            {toDo.length > 0 && (
              <ul className="setup-lines">
                {toDo.map((line) => (
                  <Line key={line.id} line={line} list={list} runs={runs} />
                ))}
              </ul>
            )}
            {here.length > 0 && (
              <details className="setup-already">
                <summary>Completed or dismissed ({here.length})</summary>
                <ul className="setup-lines">
                  {here.map((line) => (
                    <Line key={line.id} line={line} list={list} runs={runs} />
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export function SetupThisComputerPage() {
  // A sign-in that finishes changes which agents are ready: the list is asked again.
  const agents = useAgentStatus();
  const { value, refresh } = useResource(SETUP_PATH, asSetupList, agents?.available.join(',') ?? '');
  // Check again reads this computer afresh; the button says so while it does, and when it last did.
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const checkAgain = async () => {
    setChecking(true);
    try {
      await refresh();
      setCheckedAt(Date.now());
    } finally {
      setChecking(false);
    }
  };
  const runs = useSetupRuns();
  const here = thisComputer();
  // Leaving the page lets the results from this visit go (18.5).
  useEffect(() => () => setupSteps.forget(), []);
  const back = (
    <div>
      <button type="button" className="secondary-button small" {...backToConnections}>
        <ArrowLeft aria-hidden /> Back to Connections
      </button>
    </div>
  );
  const help = <p className="settings-help">What your other computers have that {here} does not. Each sign-in is made here. A missing value is entered here, or copied from the computer that has it once you say Allow there. Every line checks itself each time this page opens, and nothing runs until you press its button.</p>;
  if (value.state !== 'ready')
    return (
      <>
        <SettingHeading level={1} title={`Set up ${here}`} help={help} />
        <section className="settings-section">
          <p className="settings-help" role={value.state === 'unavailable' ? 'alert' : 'status'}>{value.state === 'unavailable' ? value.reason : 'Reading your computers…'}</p>
          {back}
        </section>
      </>
    );
  const list = value.value;
  const left = setupLeft(list);
  const sections = SETUP_GROUPS.filter(({ id }) => list.lines.some((l) => l.group === id && !l.dismissed))
    .map(({ id }) => setupSectionOf(id, list.lines, runs));
  const active = sections.filter((section) => !section.finished);
  const finished = sections.filter((section) => section.finished);
  const dismissed = list.lines.filter((l) => l.dismissed);
  return (
    <>
      <SettingHeading level={1} title={`Set up ${here}`} help={help} />
      <section className="settings-section setup-summary">
        {list.others.length === 0 ? (
          <p className="settings-help">No other computer in your account has written its set-up yet. Open Settings → Connections on that computer while it is connected, then come back.</p>
        ) : (
          <p className="settings-help" role="status">
            From {list.others.map((o) => `${o.name} (read ${when(o.readAt)})`).join(', ')}. {left === 0 ? `${list.here.name} has what they have.` : `${left} left to do.`}
          </p>
        )}
        {list.problems.length > 0 && <p className="settings-help">On {list.here.name}: {list.problems.join(' ')}</p>}
        <div className="setup-summary-actions">
          <button type="button" className="secondary-button small" disabled={checking} onClick={() => void checkAgain()}>
            <RefreshCw className={checking ? 'is-running' : undefined} aria-hidden /> {checking ? 'Checking…' : 'Check again'}
          </button>
          <button type="button" className="secondary-button small" {...backToConnections}>
            <ArrowLeft aria-hidden /> Back to Connections
          </button>
          {checkedAt !== null && !checking && (
            <span className="settings-help" role="status">
              Checked {when(checkedAt)}.
            </span>
          )}
        </div>
      </section>
      {active.length > 0 && (
        <div className="setup-groups">
          {active.map((section) => (
            <SectionCard key={section.group} section={section} list={list} runs={runs} />
          ))}
        </div>
      )}
      {finished.length > 0 && (
        <details className="settings-section setup-already">
          <summary>Completed ({finished.length})</summary>
          <div className="setup-groups">
            {finished.map((section) => (
              <SectionCard key={section.group} section={section} list={list} runs={runs} />
            ))}
          </div>
        </details>
      )}
      {dismissed.length > 0 && (
        <details className="settings-section setup-already">
          <summary>Dismissed ({dismissed.length})</summary>
          {/* The same cards the steps came out of, one per section, so a dismissed step looks like the step it is. */}
          <div className="setup-groups">
            {SETUP_GROUPS.filter((g) => dismissed.some((l) => l.group === g.id)).map((g) => (
              <section key={g.id} className="setup-group" aria-label={`Dismissed from ${g.title}`}>
                <div className="setup-group-header">
                  <span className="setup-group-title">{g.title}</span>
                </div>
                <div className="setup-group-steps">
                  <ul className="setup-lines">
                    {dismissed.filter((l) => l.group === g.id).map((line) => (
                      <Line key={line.id} line={line} list={list} runs={runs} />
                    ))}
                  </ul>
                </div>
              </section>
            ))}
          </div>
        </details>
      )}
    </>
  );
}
