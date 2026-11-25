// Add a server (`#/settings/agent-setup/mcp/new`, or `…/new/<projectId>` from a project's tab) and a
// server's own page (`#/settings/agent-setup/mcp/<name>`): a page in the main canvas, never a panel.
// What is typed is a draft saved by the screen's one Save bar (`useDraft`); this page has no Save
// button. Every environment variable and header is secret unless its switch says otherwise; after
// saving, a secret shows only as set or not set, and typing into it replaces it. Test starts or reaches
// the server once and lists its tools. Remove asks first and cannot be undone: its values are deleted.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, FlaskConical, Plus, Trash2, X } from 'lucide-react';
import { KIND_LABEL, MCP_KINDS, type McpKind, type McpServerView } from '@kestrel/server/mcp-servers';
import { fetchResource } from '../data/resources.ts';
import { asServerList, MCP_SERVERS_PATH, serverSection, useMcpServers } from '../components/McpServers.tsx';
import { SettingRow } from '../components/SettingRow.tsx';
import { SettingHeading } from '../components/SettingHelp.tsx';
import { opener, openView } from '../route.ts';
import { act, call, OLDER_SERVER, RESTART_REASON, useApp } from '../store.ts';
import { useDraft } from '../unsaved.ts';

interface ValueRow {
  id: number;
  key: string;
  secret: boolean;
  /** Typed this time. For a secret, empty keeps what is stored. */
  value: string;
  /** A secret has a value stored on this computer. */
  set: boolean;
  /** A stored secret to be cleared on save. */
  clear: boolean;
}

interface Draft {
  name: string;
  kind: McpKind;
  command: string;
  /** One argument per line. */
  args: string;
  url: string;
  values: ValueRow[];
  /** '' for every project. */
  projectId: string;
}

let nextRowId = 1;
const row = (over: Partial<ValueRow> = {}): ValueRow => ({ id: nextRowId++, key: '', secret: true, value: '', set: false, clear: false, ...over });

const emptyDraft = (projectId: string): Draft => ({ name: '', kind: 'http', command: '', args: '', url: '', values: [], projectId });

function draftOf(server: McpServerView): Draft {
  const values = (server.kind === 'stdio' ? server.env : server.headers).map((v) => row({ key: v.key, secret: v.secret, value: v.secret ? '' : (v.value ?? ''), set: v.set }));
  return { name: server.name, kind: server.kind, command: server.command ?? '', args: (server.args ?? []).join('\n'), url: server.url ?? '', values, projectId: server.projectId ?? '' };
}

/** What is sent: the rows as the server takes them, secrets only when typed. */
function bodyOf(draft: Draft): Record<string, unknown> {
  const values = draft.values.map((v) => ({ key: v.key.trim(), secret: v.secret, ...(v.secret ? (v.value ? { value: v.value } : {}) : { value: v.value }), ...(v.secret && v.clear && !v.value ? { clear: true } : {}) }));
  const base = { name: draft.name.trim(), kind: draft.kind, projectId: draft.projectId || null };
  return draft.kind === 'stdio'
    ? { ...base, command: draft.command.trim(), args: draft.args.split('\n').map((a) => a.trim()).filter(Boolean), env: values }
    : { ...base, url: draft.url.trim(), headers: values };
}

/** Comparable form: what would be saved, without the row ids. */
const shape = (draft: Draft): string => JSON.stringify(bodyOf(draft));

function problemOf(draft: Draft): string | null {
  if (!draft.name.trim()) return 'Give the server a name.';
  if (draft.kind === 'stdio' && !draft.command.trim()) return 'Give the command to run.';
  if (draft.kind !== 'stdio' && !draft.url.trim()) return 'Give the address.';
  if (draft.values.some((v) => !v.key.trim() && (v.value || v.set))) return 'Each value needs a name.';
  return null;
}

const refreshList = () => fetchResource(MCP_SERVERS_PATH, asServerList);
const back = () => openView({ kind: 'settings', section: 'agent-setup' }, false);

function ValueRows({ draft, setDraft }: { draft: Draft; setDraft: (d: Draft) => void }) {
  const local = draft.kind === 'stdio';
  const change = (id: number, patch: Partial<ValueRow>) => setDraft({ ...draft, values: draft.values.map((v) => (v.id === id ? { ...v, ...patch } : v)) });
  return (
    <div className="mcp-values">
      {draft.values.length === 0 && <p className="setup-none">None.</p>}
      {draft.values.map((v) => (
        <div className="mcp-value-row" key={v.id}>
          <input className="form-control mcp-value-key" aria-label={local ? 'Variable name' : 'Header name'} placeholder={local ? 'API_TOKEN' : 'Authorization'} spellCheck={false} value={v.key} onChange={(e) => change(v.id, { key: e.target.value })} />
          <input
            className="form-control mcp-value-value"
            aria-label={`Value of ${v.key || 'this value'}`}
            type={v.secret ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            placeholder={v.secret ? (v.set && !v.clear ? 'Set. Type to replace it' : 'Not set') : 'Value'}
            value={v.value}
            onChange={(e) => change(v.id, { value: e.target.value })}
          />
          <label className="mcp-value-secret" title="A secret is sealed on this computer and never shown again">
            <input type="checkbox" checked={v.secret} onChange={(e) => change(v.id, { secret: e.target.checked, value: e.target.checked ? '' : v.value })} />
            Secret
          </label>
          {v.secret && v.set && !v.clear && (
            <button type="button" className="link-button" onClick={() => change(v.id, { clear: true, value: '' })}>
              Clear
            </button>
          )}
          <button type="button" className="icon-button" aria-label={`Remove ${v.key || 'this value'}`} onClick={() => setDraft({ ...draft, values: draft.values.filter((x) => x.id !== v.id) })}>
            <X aria-hidden />
          </button>
        </div>
      ))}
      <div>
        <button type="button" className="secondary-button small" onClick={() => setDraft({ ...draft, values: [...draft.values, row()] })}>
          <Plus aria-hidden />
          {local ? 'Add a variable' : 'Add a header'}
        </button>
      </div>
    </div>
  );
}

function Editor({ stored, projectId }: { stored: McpServerView | null; projectId: string }) {
  const projects = useApp((s) => s.workspace?.projects) ?? [];
  const initial = useMemo(() => (stored ? draftOf(stored) : emptyDraft(projectId)), [stored, projectId]);
  const [draft, setDraft] = useState(initial);
  useEffect(() => setDraft(initial), [initial]);
  /** A server just added: its page opens once this draft reads as saved, so leaving does not ask. */
  const [added, setAdded] = useState<string | null>(null);
  const changed = added === null && shape(draft) !== shape(initial);
  const problem = changed ? problemOf(draft) : null;
  const save = async (): Promise<boolean> => {
    const body = JSON.stringify(bodyOf(draft));
    const saved = await act(() => (stored ? call<McpServerView>(`${MCP_SERVERS_PATH}/${encodeURIComponent(stored.name)}`, { method: 'PUT', body }) : call<McpServerView>(MCP_SERVERS_PATH, { method: 'POST', body })));
    if (!saved) return false;
    await refreshList();
    if (!stored) setAdded(saved.name);
    return true;
  };
  const anchor = useDraft({ what: stored ? `MCP server ${stored.name}` : 'New MCP server', changed, problem, save, discard: () => setDraft(initial) });
  // After the draft above has been told it is saved (effects run in order).
  useEffect(() => {
    if (added) openView({ kind: 'settings', section: serverSection(added) }, false);
  }, [added]);
  const local = draft.kind === 'stdio';
  const id = (part: string) => `mcp-${stored?.name ?? 'new'}-${part}`;
  return (
    <section className="settings-section wide mcp-server-form">
      <SettingRow label="Name" htmlFor={id('name')}>
        <input id={id('name')} className="form-control" spellCheck={false} placeholder="n8n" value={draft.name} disabled={stored !== null} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </SettingRow>
      <SettingRow label="Kind">
        <div className="settings-choices" role="radiogroup" aria-label="Kind">
          {MCP_KINDS.map((k) => (
            <label key={k} className="settings-choice">
              <input type="radio" name={id('kind')} checked={draft.kind === k} onChange={() => setDraft({ ...draft, kind: k })} />
              {KIND_LABEL[k]}
            </label>
          ))}
        </div>
      </SettingRow>
      {local ? (
        <>
          <SettingRow label="Command" htmlFor={id('command')}>
            <input id={id('command')} className="form-control" spellCheck={false} placeholder="npx" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
          </SettingRow>
          <SettingRow label="Arguments" htmlFor={id('args')} help={<p className="settings-help">One argument per line, as they are passed to the command.</p>}>
            <textarea id={id('args')} className="form-control project-script" rows={3} spellCheck={false} placeholder={'-y\n@acme/notes-mcp'} value={draft.args} onChange={(e) => setDraft({ ...draft, args: e.target.value })} />
          </SettingRow>
          <p className="settings-help">Runs on this computer as you, started by the session's agent outside its sandbox.</p>
        </>
      ) : (
        <SettingRow label="Address" htmlFor={id('url')}>
          <input id={id('url')} className="form-control" spellCheck={false} placeholder="https://example.com/mcp" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
        </SettingRow>
      )}
      {draft.kind === 'sse' && <p className="settings-help">Codex speaks only streamable HTTP, so this server is left out of Codex sessions; Claude and OpenCode sessions get it.</p>}
      <SettingRow label={local ? 'Environment variables' : 'Headers'} stacked help={<p className="settings-help">Each value is secret unless you switch that off: a secret is sealed on this computer, never copied to another, and shown only as set or not set once saved. It is put only into this server's own entry when a session starts.</p>}>
        <ValueRows draft={draft} setDraft={setDraft} />
      </SettingRow>
      <SettingRow label="Applies to" htmlFor={id('where')}>
        <select id={id('where')} className="form-control" value={draft.projectId} onChange={(e) => setDraft({ ...draft, projectId: e.target.value })}>
          <option value="">Every project (the default set)</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} only
            </option>
          ))}
        </select>
      </SettingRow>
      {problem && <span className="delegation-limit-problem" role="alert">{problem}</span>}
      <span ref={anchor} className="draft-anchor" />
    </section>
  );
}

type TestState = { state: 'idle' } | { state: 'testing' } | { state: 'done'; tools: { name: string; description?: string }[] } | { state: 'failed'; error: string };

function TestAndRemove({ server }: { server: McpServerView }) {
  const [test, setTest] = useState<TestState>({ state: 'idle' });
  const [confirming, setConfirming] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => void (live.current = false);
  }, []);
  const runTest = async () => {
    setTest({ state: 'testing' });
    const answer = await act(() => call<{ ok: true; tools: { name: string; description?: string }[] } | { ok: false; error: string }>(`${MCP_SERVERS_PATH}/${encodeURIComponent(server.name)}/test`, { method: 'POST' }));
    if (!live.current) return;
    setTest(!answer ? { state: 'idle' } : answer.ok ? { state: 'done', tools: answer.tools } : { state: 'failed', error: answer.error });
  };
  const remove = async () => {
    const done = await act(() => call(`${MCP_SERVERS_PATH}/${encodeURIComponent(server.name)}`, { method: 'DELETE' }));
    if (done === undefined) return;
    await refreshList();
    back();
  };
  return (
    <section className="settings-section wide">
      <SettingHeading title="Test" help={<p className="settings-help">Starts or reaches the server once, as saved, and lists its tools. Save a change first.</p>} />
      <div className="mcp-servers-actions">
        <button type="button" className="secondary-button small" disabled={test.state === 'testing'} onClick={() => void runTest()}>
          <FlaskConical aria-hidden />
          {test.state === 'testing' ? 'Testing…' : 'Test'}
        </button>
      </div>
      {test.state === 'done' && (
        <div className="mcp-test-result">
          <p className="settings-help">
            {test.tools.length === 0 ? 'It answered, with no tools.' : `It answered with ${test.tools.length} tool${test.tools.length === 1 ? '' : 's'}:`}
          </p>
          <ul className="mcp-tools">
            {test.tools.map((t) => (
              <li key={t.name}>
                <code>{t.name}</code>
                {t.description && <small> {t.description.split('\n')[0]}</small>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {test.state === 'failed' && <pre className="mcp-test-error" role="alert">{test.error}</pre>}
      <h2 className="mcp-remove-heading">Remove</h2>
      {!confirming ? (
        <div>
          <button type="button" className="secondary-button small danger" onClick={() => setConfirming(true)}>
            <Trash2 aria-hidden />
            Remove {server.name}
          </button>
        </div>
      ) : (
        <div className="worktree-confirm" role="group" aria-label={`Remove ${server.name}`}>
          <p>This removes {server.name} from Kestrel and deletes its secret values from this computer. It cannot be undone. Sessions already running keep it until they end.</p>
          <button type="button" className="secondary-button small danger" onClick={() => void remove()}>
            Remove {server.name}
          </button>
          <button type="button" className="link-button" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}

/** `name`: the server's, or 'new'; `projectId`: for Add a server to a project. */
export function McpServerPage({ name, projectId = '' }: { name: string; projectId?: string }) {
  const list = useMcpServers();
  const adding = name === 'new';
  const heading = adding ? 'Add a server' : name;
  const backLink = (
    <button type="button" className="secondary-button small mcp-back" {...opener((newTab) => openView({ kind: 'settings', section: 'agent-setup' }, newTab))}>
      <ArrowLeft aria-hidden />
      Back to Agent setup
    </button>
  );
  if (list.state !== 'ready') return <>{backLink}<p className="settings-help">{list.state === 'loading' ? 'Loading…' : list.reason === RESTART_REASON ? OLDER_SERVER : list.reason}</p></>;
  const server = adding ? null : (list.value.servers.find((s) => s.name === name) ?? null);
  return (
    <>
      {backLink}
      <SettingHeading level={1} title={heading} help={<p className="settings-help">An MCP server Kestrel hands to Claude, Codex and OpenCode sessions when they start. Changes apply to sessions started from now on.</p>} />
      {!adding && !server ? (
        <p className="settings-help">There is no MCP server named {name}.</p>
      ) : (
        <>
          <Editor key={server?.name ?? 'new'} stored={server} projectId={projectId} />
          {server && <TestAndRemove server={server} />}
        </>
      )}
    </>
  );
}
