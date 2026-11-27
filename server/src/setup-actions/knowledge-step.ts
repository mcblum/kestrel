// Use the other computer's knowledge base here (docs/designs/onboarding.md, 18.15). Run is the person
// picking it: the same call Settings → Workflow → Knowledge base makes (`Knowledge.setSettings`), which
// refuses a project whose default branch holds no kestrel-knowledge.json. A different knowledge base in
// use here is never replaced without asking: the line waits on Replace or Keep yours.
import type { SetupAction } from '../shared/setup-list.ts';
import { failed, type ExecuteDeps } from './execute.ts';
import type { StepContext, StepResult } from './steps.ts';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function knowledgeStep(deps: ExecuteDeps, ctx: StepContext, action: Extract<SetupAction, { kind: 'knowledge' }>): Promise<StepResult> {
  const target = deps.knowledge;
  if (!target) return failed('This copy of Kestrel cannot set the knowledge base from here. Use Settings → Workflow → Knowledge base.');
  const project = await target.projectOf(action.repo);
  if (!project) return failed(`No project here is ${action.repo}. Clone it first, then Run again.`);
  const current = await target.current();
  if (current?.projectId === project.projectId) return { state: 'done', said: `${project.name} is already the knowledge base here.` };
  if (current && ctx.input.differ !== 'replace') {
    if (ctx.input.differ === 'keep') return { state: 'done', said: `Kept ${current.name} as the knowledge base here.` };
    return { state: 'waiting', ask: 'replace-or-keep', on: `you: this computer uses ${current.name} as its knowledge base. Replace it with ${project.name}, or Keep yours.` };
  }
  try {
    await target.use(project.projectId);
  } catch (error) {
    return failed(message(error));
  }
  return { state: 'done', said: `${project.name} is the knowledge base here now.`, undo: () => target.use(current?.projectId ?? null) };
}
