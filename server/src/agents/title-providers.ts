// Who can write Kestrel's own short texts: a session's title, and a pull request's title and summary
// ("Create PR → Generated"). Neither depends on the session's adapter: a user with OpenAI and no
// Claude still gets them from Codex. The provider matching the session's agent is asked first, then
// the rest (runtime/titling.ts, pull-requests/generate.ts). Titles use a small fast model; a pull
// request's text uses the session's own model when it is asked of the session's agent. Which
// providers exist is chosen once, when the server starts (index.ts).
import type { Agent } from '../model.ts';
import { claudePullRequestText, claudeTitle } from './claude/title.ts';
import { codexPullRequestText, codexTitle } from './codex/title.ts';
import { scriptedTitle } from './scripted.ts';

export interface TitleProvider {
  /** For the log line when it fails. */
  readonly name: string;
  /** The agent it belongs with: asked first for that agent's sessions. */
  readonly agent: Agent;
  /** The raw reply (the runtime cleans it); null when it has none or is not installed; may throw. */
  title(prompt: string): Promise<string | null>;
  /**
   * The raw reply to a pull request text request (pr-text-request.ts); null or a throw as for
   * `title`. `model` is the session's model when this provider is the session's agent; absent means
   * this agent's default. Absent from the scripted stand-in: sample data makes up its own pre-fill (fake.ts).
   */
  pullRequestText?(request: string, model?: string): Promise<string | null>;
}

export type TitleMode = 'real' | 'scripted' | 'none';

/** The providers for how the server was started: real CLIs, the scripted stand-in, or none. */
export function titleProviders(mode: TitleMode): TitleProvider[] {
  if (mode === 'scripted') return [{ name: 'scripted', agent: 'claude', title: scriptedTitle }];
  if (mode === 'none') return [];
  return [
    { name: 'claude', agent: 'claude', title: (prompt) => claudeTitle(prompt), pullRequestText: (request, model) => claudePullRequestText(request, model) },
    { name: 'codex', agent: 'codex', title: (prompt) => codexTitle(prompt), pullRequestText: (request, model) => codexPullRequestText(request, model) },
  ];
}

/** The providers in the order to ask them for a session of `agent`: its own first, then the others. */
export const providersFor = (providers: readonly TitleProvider[], agent: Agent): TitleProvider[] => [
  ...providers.filter((p) => p.agent === agent),
  ...providers.filter((p) => p.agent !== agent),
];
