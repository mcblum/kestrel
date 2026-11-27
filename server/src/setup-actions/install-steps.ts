// Installing a tool or an agent, and opening a page (onboarding.md 18.2 and 18.7). The route is the one
// table's (setup-install.ts), worked out again here from this computer, never taken from the page. A
// route that needs a password typed (`paste`) is never run; `os-prompt` starts the command and the
// operating system asks for the administrator itself. Nothing here is undone: an uninstall is not exact.
import { agentRecipeOf, installRecipeOf, type InstallRecipe } from '../shared/setup-install.ts';
import type { SetupAction } from '../shared/setup-list.ts';
import type { Platform } from '../shared/platform.ts';
import { failed, LIMIT, runFor, type ExecuteDeps } from './execute.ts';
import type { StepContext, StepResult } from './steps.ts';

async function runRecipe(deps: ExecuteDeps, ctx: StepContext, recipe: InstallRecipe | null, what: string): Promise<StepResult> {
  if (!recipe) return failed(`Kestrel does not know how to install ${what} here: install it the way you usually do, then Check again.`);
  if (recipe.run === 'paste' || !recipe.argv) return failed(`Installing ${what} needs an administrator: paste its command into a terminal, then Check again.`);
  if (recipe.run === 'open') return openUrl(deps, ctx, recipe.url ?? '', what);
  if (recipe.run === 'os-prompt') ctx.say(`your operating system's own prompt, if it asks for an administrator to install ${what}`);
  const problem = await runFor(deps, ctx, recipe.argv, LIMIT.install, { env: { HOMEBREW_NO_AUTO_UPDATE: '1', NONINTERACTIVE: '1' } });
  return problem ?? { state: 'done', said: `Installed ${what}.` };
}

export function installStep(deps: ExecuteDeps, ctx: StepContext, action: Extract<SetupAction, { kind: 'install' }>): Promise<StepResult> {
  return runRecipe(deps, ctx, installRecipeOf(action.tool, deps.platform, deps.host(), action.why), action.tool);
}

export function agentInstallStep(deps: ExecuteDeps, ctx: StepContext, action: Extract<SetupAction, { kind: 'agent-install' }>): Promise<StepResult> {
  return runRecipe(deps, ctx, agentRecipeOf(action.agent, deps.platform, deps.host()), ctx.line.title.replace(/^Install /, ''));
}

/** The program that opens a page in the person's browser or App Store. */
const OPENER: Record<Platform, string[]> = { mac: ['open'], linux: ['xdg-open'], windows: ['explorer'] };

async function openUrl(deps: ExecuteDeps, ctx: StepContext, url: string, what: string): Promise<StepResult> {
  // Only Kestrel's own pages (setup-install.ts) are opened; nothing from a record.
  if (!/^(https:\/\/|macappstores:\/\/)/.test(url)) return failed('That page cannot be opened from here.');
  const problem = await runFor(deps, ctx, [...OPENER[deps.platform], url], LIMIT.other);
  // Windows' explorer ends with 1 even when it opened the page.
  if (problem && !(deps.platform === 'windows' && problem.state === 'failed' && /code 1\./.test(problem.reason))) return problem;
  return { state: 'done', said: `Opened ${what}'s page. Check again once it is installed.` };
}

export function openStep(deps: ExecuteDeps, ctx: StepContext): Promise<StepResult> {
  const action = ctx.line.action;
  const recipe = action?.kind === 'install' ? installRecipeOf(action.tool, deps.platform, deps.host(), action.why) : null;
  return openUrl(deps, ctx, recipe?.url ?? '', ctx.line.title);
}
