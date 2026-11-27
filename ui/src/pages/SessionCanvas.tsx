import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CircleCheck, CircleHelp, Folder, GitFork } from 'lucide-react';
import type { SessionView, TreeNode, WorkspaceState } from '@kestrel/server/model';
import { buildTree } from '@kestrel/server/tree';
import { activityAt, orderTree } from '@kestrel/server/session-order';
import { sessionDot } from '@kestrel/server/unread';
import { useApp } from '../store.ts';
import { statusOf } from '@kestrel/server/status';
import { age, projectName, statusText } from '../labels.ts';
import { opener, openSession } from '../route.ts';
import { useMinuteNow } from '../useNow.ts';
import './session-canvas.css';

const windows = [
  [10, '10 min'], [30, '30 min'], [60, '1 hour'], [360, '6 hours'], [1440, '24 hours'], [0, 'All time'],
] as const;

function members(node: TreeNode): string[] {
  return [node.sessionId, ...node.children.flatMap(members)];
}


export function SessionCanvas({ sessions, workspace, needs }: {
  sessions: SessionView[]; workspace: WorkspaceState; needs: SessionView[];
}) {
  const demo = import.meta.env.DEV && (import.meta.env.VITE_SIMULATE_ACTIVITY === '1' || new URLSearchParams(location.search).get('simulate') === '1');
  const [playing, setPlaying] = useState(demo);
  const [activity, setActivity] = useState<ReadonlyMap<string, number>>(() => new Map());
  const seen = useApp(state => state.seen);
  const workers = useMemo(() => sessions.filter(s => statusOf(s) === 'working'), [sessions]);
  const cursor = useRef(0);
  const currentWorkers = useRef(workers);
  useLayoutEffect(() => { currentWorkers.current = workers; }, [workers]);
  const advance = useCallback(() => {
    const candidates = currentWorkers.current;
    if (!candidates.length) return;
    const session = candidates[cursor.current++ % candidates.length]!;
    const time = Date.now();
    setActivity(previous => new Map(previous).set(session.id, time));
  }, []);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(advance, 3500);
    return () => window.clearInterval(timer);
  }, [playing, advance]);
  const byId = useMemo(() => new Map(sessions.map(s => {
    const simulated = activity.get(s.id);
    return [s.id, simulated && simulated > activityAt(s) && statusOf(s) === 'working' ? { ...s, lastActivityAt: simulated } : s];
  })), [sessions, activity]);
  const forest = useMemo(() => orderTree(buildTree([...byId.keys()], workspace.links), id => byId.get(id), 'recent', []), [byId, workspace.links]);
  const now = useMinuteNow();
  const [minutes, setMinutes] = useState<number>(() => {
    const saved = sessionStorage.getItem('canvas-activity-minutes');
    return windows.find(([value]) => String(value) === saved)?.[0] ?? 30;
  });
  const trees = useMemo(() => forest.map(root => ({ root, ids: members(root) })), [forest]);
  const shown = useMemo(() => trees.filter(({ ids }) => !minutes ||
    ids.some(id => activityAt(byId.get(id)!) >= now - minutes * 60_000)), [trees, minutes, now, byId]);
  const visible = new Set(shown.flatMap(tree => tree.ids));
  const working = sessions.filter(s => visible.has(s.id) && statusOf(s) === 'working').length;
  const attention = new Set(needs.map(s => s.id));
  const grid = useRef<HTMLUListElement>(null);
  const positions = useRef(new Map<string, { x: number; y: number }>());
  useLayoutEffect(() => {
    const previous = positions.current;
    const next = new Map<string, { x: number; y: number }>();
    const canvas = grid.current!;
    const origin = canvas.getBoundingClientRect();
    const cards = Array.from(canvas.querySelectorAll<HTMLElement>('[data-session]'));
    for (const card of cards) card.getAnimations().forEach(animation => animation.cancel());
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      next.set(card.dataset.session!, { x: rect.left - origin.left, y: rect.top - origin.top });
    }
    let active = true;
    const movingTrees = new Map<HTMLElement, Animation[]>();
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const card of cards) {
        const id = card.dataset.session!;
        const old = previous.get(id);
        const pos = next.get(id)!;
        if (old && old.x === pos.x && old.y === pos.y) continue;
        const from = old ? { transform: `translate(${old.x-pos.x}px,${old.y-pos.y}px)` } : { opacity: 0, transform: 'translateY(8px)' };
        const motion = card.animate([from, { opacity: 1, transform: 'none' }], { duration: old ? 950 : 450, easing: 'cubic-bezier(.2,.8,.2,1)' });
        const tree = card.closest<HTMLElement>('.canvas-grid > li')!;
        const motions = movingTrees.get(tree);
        if (motions) motions.push(motion);
        else movingTrees.set(tree, [motion]);
      }
    }
    for (const [tree, motions] of movingTrees) {
      tree.classList.add('canvas-tree-moving');
      void Promise.allSettled(motions.map(motion => motion.finished)).then(() => {
        if (active) tree.classList.remove('canvas-tree-moving');
      });
    }
    positions.current = next;
    return () => {
      active = false;
      for (const tree of movingTrees.keys()) tree.classList.remove('canvas-tree-moving');
    };
  }, [shown]);

  function branch(node: TreeNode, treeActivity?: number, latest = false, treeSize?: number) {
    const s = byId.get(node.sessionId)!;
    const waiting = attention.has(s.id);
    const running = statusOf(s) === 'working';
    const unread = sessionDot(s, seen) === 'unread';
    const Icon = waiting ? CircleHelp : CircleCheck;
    return <li key={s.id} style={treeSize ? { '--tree-size': treeSize } as CSSProperties : undefined}>
      <button type="button" className="canvas-card" data-session={s.id} data-state={waiting ? 'attention' : running ? 'working' : unread ? 'unread' : 'quiet'} {...opener(newTab => openSession(s.id, newTab))}>
        <span className="canvas-meta"><Folder size={12}/>{projectName(s, workspace.projects)}<time title={treeActivity === undefined ? 'Session activity' : 'Latest activity in this tree'}>{latest ? 'Most recent · ' : ''}{age(treeActivity ?? activityAt(s), now)}</time></span>
        <strong title={s.title}>{s.title}</strong>
        <span className="canvas-state">{running ? <span className="working-pulse" aria-hidden /> : <Icon size={13}/>}{waiting ? 'Needs you' : statusText(s)}{unread && !waiting && ' · Unread'}</span>
        {(waiting || running) && s.note && <span className="canvas-note" title={s.note}>{s.note}</span>}
      </button>
      {node.children.length > 0 && <ul>{node.children.map(child => branch(child))}</ul>}
    </li>;
  }
  return <section className="session-canvas">
    <header><GitFork size={22}/><h1>Session map</h1></header>
    <div className="canvas-filter" role="group" aria-label="Session tree activity window">
      <span>Active within</span>
      {windows.map(([value, label]) => <button type="button" key={value} aria-pressed={minutes === value}
        onClick={() => { setMinutes(value); sessionStorage.setItem('canvas-activity-minutes', String(value)); }}>{label}</button>)}
      {demo && <><button type="button" className="canvas-simulate" onClick={() => setPlaying(value => !value)}>
        {playing ? 'Pause simulation' : 'Resume simulation'}
      </button><button type="button" disabled={!workers.length} onClick={advance}>Next activity</button></>}
    </div>
    <div className="canvas-summary" role="status"><span>{visible.size} of {sessions.length} sessions</span><span>{working} working</span><span>{needs.filter(s => visible.has(s.id)).length} need you</span></div>
    {sessions.length > 0 && !shown.length && <p>No session trees active in this window.</p>}
    {!sessions.length && <p>Your sessions will appear here when you start work.</p>}
    <ul className="canvas-grid" ref={grid}>{shown.map((tree, index) => branch(tree.root, tree.ids.reduce((at, id) => Math.max(at, activityAt(byId.get(id)!)), 0), index === 0, tree.ids.length))}</ul>
  </section>;
}
