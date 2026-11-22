// A busy, organization-sized workspace for checking sidebar hierarchy. Sample data only.
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Workspace } from './workspace.ts';
import type { Persistence } from './persistence/types.ts';
import { sanitizeSidebar } from './shared/sidebar.ts';
import { ColourPrefs } from './colours/prefs.ts';

const DAY = 24 * 60 * 60 * 1000;

/** More terraform work, some of it days old, so the project folds (shared/sidebar-fold.ts): [id, title, days ago, state]. */
const TERRAFORM_HISTORY = [
  ['tf-plan-drift', 'Plan drift in the staging account', 0, 'attention'],
  ['tf-iam-roles', 'Tighten IAM roles for the deploy runner', 0, 'done'],
  ['tf-provider-bump', 'Bump the AWS provider to 6.x', 2, 'done'],
  ['tf-state-lock', 'Move state locking to the new table', 3, 'done'],
  ['tf-vpc-peering', 'VPC peering for the analytics account', 4, 'done'],
  ['tf-rds-snapshots', 'Nightly RDS snapshots across regions', 6, 'done'],
  ['tf-module-docs', 'Document the shared network module', 8, 'done'],
  ['tf-cost-tags', 'Cost allocation tags on every resource', 9, 'done'],
] as const;

/**
 * Seeds the store behind `db`. It works through a workspace of its own whose clock it can set back,
 * so some sessions are days old; the app's workspace reads the result afterwards.
 */
export async function seedSidebar(db: Persistence, dataDir: string): Promise<void> {
  let now = Date.now();
  const ws = new Workspace(db, () => now);
  const projects = ['aegis', 'anubis', 'cdo-frontend-nx', 'cdo-jvm-modules', 'cdo-modules', 'cdo-python-modules', 'cdo-platform-ai', 'infrastructure', 'janus_cookbook', 'lar-toolkit', 'terraform', 'zeus'];
  for (const id of projects) {
    const path = join(dataDir, 'projects', id);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'README.md'), `# ${id}\n\nSample project for the sidebar demo.\n`);
    await ws.addProject({ id, name: id, path, isGit: false });
  }
  const tasks = [
    ['argus-deploy', 'Augment Argus deployment functionality', 'cdo-platform-ai'],
    ['traces', 'Add traces permissions to Argus group map', 'terraform'],
    ['microtemplates', 'Centralize shared microtemplate templates', 'cdo-jvm-modules'],
    ['migration', 'Terraform deployment migration flag and FMT', 'terraform'],
    ['recovery', 'DR Lite failure procedure for upgrades', 'infrastructure'],
    ['nginx', 'Investigate Nginx vulnerabilities', 'janus_cookbook'],
    ['asa', 'ProdF9 ASA upgrade', null],
  ] as const;
  for (const [id, title, project] of tasks) {
    await ws.addSession({ id, title, agent: 'claude', startedIn: project, landedIn: project, state: 'done', note: 'Ready to review', ...(['traces', 'microtemplates'].includes(id) ? { review: { key: `demo/${id}`, host: 'github' as const, number: id === 'traces' ? 9064 : 10016, sha: 'a'.repeat(40), url: `https://example.invalid/reviews/${id}` } } : {}) });
    await ws.setDetail(id, { messages: [{ author: 'you', time: '09:10', text: title }, { author: 'agent', time: '09:24', text: 'The sample changes are ready for review. This conversation is demo data.' }], files: [], agentOutput: '' });
  }
  const split = await ws.delegate('argus-deploy', [{ projectId: 'terraform', brief: 'Enable Argus DVS deployment writes in staging' }], { name: 'Argus: create deployments', objective: 'Enable deployment creation across the platform and infrastructure.' });
  for (const child of split.children) {
    await ws.setLandedIn(child.id, 'terraform');
    await ws.setState(child.id, 'done', 'Ready to review');
  }
  for (const [id, title, daysAgo, state] of TERRAFORM_HISTORY) {
    now = Date.now() - daysAgo * DAY - 60 * 60 * 1000;
    await ws.addSession({ id, title, agent: 'claude', startedIn: 'terraform', landedIn: 'terraform', state, note: state === 'attention' ? 'Waiting on your answer' : 'Ready to review' });
    await ws.setDetail(id, { messages: [{ author: 'you', time: '09:10', text: title }, { author: 'agent', time: '09:24', text: 'This conversation is demo data.' }], files: [], agentOutput: '' });
  }
  now = Date.now();
  await ws.tagSession('argus-deploy', 'Argus');
  await ws.tagSession('traces', 'Argus');
  await ws.setPinned('session', 'asa', true);
  await ws.setPinned('session', 'migration', true);
  // A colour per project, tag and workstream the demo opens (Settings → Colours), so the guide lines show.
  const workstreams = split.workstream ? { [split.workstream.id]: 'teal' as const } : {};
  await new ColourPrefs({ settings: db }).update((current) => ({ ...current, projects: { terraform: 'blue', 'cdo-platform-ai': 'orange', infrastructure: 'brown' }, tags: { argus: 'pink' }, workstreams }));
  // Open the two projects relevant to the demo; keep the rest available, folded.
  const state = await ws.state();
  const collapsed = [...state.groups.map(g => g.id), ...state.workstreams.filter(w => w.id !== split.workstream?.id).map(w => `workstream:${w.id}`), 'open:cdo-platform-ai', 'open:terraform'];
  await ws.setUiState(JSON.stringify({ tabs: { tabs: [{ id: 'sidebar-demo', kind: 'page', path: '#/' }], activeId: 'sidebar-demo' }, remembered: null, sidebar: sanitizeSidebar({ width: 340, projectOrder: [...projects, ...state.projects.filter(p => !projects.includes(p.id)).map(p => p.id)], collapsed }) }));
}
