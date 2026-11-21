// One fake session that shows every kind of card a conversation can hold, for building and
// checking the UI. Its pictures are expected under the data folder's media/showcase/.
import type { ChatMessage } from './model.ts';

const CHART = `<svg viewBox="0 0 520 170" xmlns="http://www.w3.org/2000/svg" font-family="system-ui" font-size="11">
  <g stroke="var(--border)" stroke-width="1"><line x1="40" y1="20" x2="40" y2="140"/><line x1="40" y1="140" x2="500" y2="140"/><line x1="40" y1="80" x2="500" y2="80" stroke-dasharray="3 4"/></g>
  <polyline fill="none" stroke="var(--fg)" stroke-width="2" points="40,120 110,96 180,104 250,60 320,72 390,38 460,44"/>
  <polyline fill="none" stroke="var(--muted)" stroke-width="2" stroke-dasharray="4 4" points="40,130 110,124 180,118 250,110 320,100 390,96 460,90"/>
  <g fill="var(--muted)"><text x="8" y="84">2 s</text><text x="8" y="144">0</text><text x="40" y="158">Mon</text><text x="250" y="158">Thu</text><text x="440" y="158">Sun</text></g>
  <g fill="var(--fg)"><text x="396" y="30">p95 checkout</text></g>
</svg>`;

const PICKER = `<div style="display:flex;gap:8px;align-items:center;font:13px system-ui;color:var(--fg)">
  <span style="color:var(--muted)">Cache lifetime</span>
  <input id="ttl" type="range" min="1" max="60" value="15" style="flex:1" oninput="out.textContent=this.value+' min'">
  <span id="out" style="width:52px">15 min</span>
  <button style="font:inherit;padding:4px 10px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--fg)" onclick="sendPrompt('Use a cache lifetime of '+ttl.value+' minutes')">Use this</button>
</div>`;

const PLAN = `## Billing v2 migration

1. Add the \`billing_v2\` tables behind a feature flag
2. Backfill accounts in batches of 500
3. Switch reads, keep dual writes for a week
4. Drop the old tables

| Step | Risk | Reversible |
|---|---|---|
| Add tables | low | yes |
| Backfill | medium | yes |
| Switch reads | medium | yes, by flag |
| Drop old tables | high | **no** |`;

export const SHOWCASE_MESSAGES: ChatMessage[] = [
  { author: 'you', time: '10:20', text: 'Checkout got slow on Tuesday. Find out why, show me, and plan the fix.' },
  { author: 'agent', time: '10:21', text: 'I’ll work through it in order.', activity: [{ icon: 'check', text: 'Read project instructions', status: 'done' }, { icon: 'terminal', text: 'Ran the pricing benchmarks', status: 'done' }] },
  { author: 'agent', time: '10:21', text: '', todos: [{ text: 'Reproduce the slow checkout', status: 'completed' }, { text: 'Profile the pricing lookup', status: 'completed' }, { text: 'Chart latency before and after', status: 'in_progress' }, { text: 'Write the migration plan', status: 'pending' }, { text: 'Run the full suite', status: 'pending' }] },
  { author: 'agent', time: '10:23', text: 'Latency doubled when the per-line pricing lookup shipped. The solid line is this week, the dashed line last week:' },
  { author: 'agent', time: '10:23', text: '', widget: { title: 'Checkout p95, this week against last', code: CHART } },
  { author: 'agent', time: '10:24', text: 'Two screenshots from the profiler:' },
  { author: 'agent', time: '10:24', text: '', images: ['profile-1.png', 'profile-2.png'] },
  { author: 'agent', time: '10:25', text: '', widget: { title: 'Try a cache lifetime', code: PICKER } },
  { author: 'agent', time: '10:26', text: '', input: { id: 'q-single', kind: 'question', tool: 'AskUserQuestion', title: 'Claude is asking you', detail: 'Where should the cache live?', options: [{ id: '0', label: 'Per request', role: 'choice' }, { id: '1', label: 'Redis', role: 'choice' }], questions: [{ question: 'Where should the cache live?', header: 'Cache', options: [{ label: 'Per request', description: 'Simplest. Gone when the request ends, so nothing to invalidate.' }, { label: 'Redis', description: 'Shared between workers. Needs an invalidation rule for price changes.' }] }] } },
  { author: 'agent', time: '10:27', text: '', input: { id: 'q-multi', kind: 'question', tool: 'AskUserQuestion', title: 'Claude is asking you', detail: 'Which checks should gate the rollout?', options: [], questions: [{ question: 'Which checks should gate the rollout?', header: 'Gates', multi: true, options: [{ label: 'Pricing suite', description: '212 tests, about two minutes.' }, { label: 'Load test', description: 'Replays Tuesday’s traffic against staging.' }, { label: 'Canary', description: '5% of carts for an hour.' }] }, { question: 'Who signs off?', header: 'Owner', options: [{ label: 'Me', description: 'You review the diff yourself.' }, { label: 'Platform on-call', description: 'They get a review request.' }] }] } },
  { author: 'agent', time: '10:28', text: '', input: { id: 'plan-1', kind: 'approval', tool: 'ExitPlanMode', title: 'Plan ready', detail: PLAN, markdown: true, options: [{ id: 'approve-edits', label: 'Approve, accept edits', role: 'allow' }, { id: 'approve-ask', label: 'Approve, ask before edits', role: 'allow' }, { id: 'deny', label: 'Keep planning', role: 'deny' }] } },
  { author: 'agent', time: '10:29', text: '', input: { id: 'plan-0', kind: 'approval', tool: 'ExitPlanMode', title: 'Plan ready', detail: PLAN, markdown: true, options: [], resolved: 'Approve, accept edits' } },
  { author: 'agent', time: '10:30', text: '', file: { path: '/tmp/kestrel-demo/checkout-latency.pdf', name: 'checkout-latency.pdf', bytes: 248_113 } },
  { author: 'agent', time: '10:30', text: '', file: { path: '/tmp/kestrel-demo/latency-by-region.csv', name: 'latency-by-region.csv', caption: 'Latency by region, last 14 days' } },
  { author: 'agent', time: '10:31', text: '', todos: [{ text: 'Reproduce the slow checkout', status: 'completed' }, { text: 'Profile the pricing lookup', status: 'completed' }, { text: 'Chart latency before and after', status: 'completed' }] },
  { author: 'agent', time: '10:31', text: '', next: { recap: 'An earlier turn ended here: the lookup is cached per request and the **pricing suite passes**.', ask: 'Run the load test?', replies: ['Run it'], done: true } },
  { author: 'agent', time: '10:32', text: '', next: { recap: 'The cause is the per-line pricing lookup. The plan is ready and **nothing has been changed yet**; the report and the CSV are above.', ask: 'Start the migration?', replies: ['Start the migration', 'Not yet'] } },
];
