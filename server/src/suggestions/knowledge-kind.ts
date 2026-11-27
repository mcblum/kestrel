// An addition or a correction to the knowledge base, as an optional action (docs/designs/knowledge.md,
// "Proposing: asked, never blocking"). Proposed by the agent through `knowledge_propose`. It never
// blocks: the turn goes on whatever the user does.
//
// The card shows the entry whole, as it would be committed: what is agreed to is what is read. There
// is no "always": every proposal sends text from this computer to a repository everyone's agents
// read, so each one is looked at. Open pull request opens it; Not now leaves it; Don't ask again
// stops proposals altogether (Settings → Workflow → Knowledge base turns them back on). An opened
// pull request has no Undo: it is closed on the host, where its reviewers already see it.
import { entryPath, PROPOSALS_PER_SESSION } from '../shared/knowledge.ts';
import type { CheckedProposal, ProposalDraft } from '../knowledge/service.ts';
import type { Pressed, Proposal, SuggestionKind } from './registry.ts';

export const KNOWLEDGE_KIND = 'knowledge';

export interface KnowledgeKindDeps {
  /** The proposal checked for this session (knowledge/service.ts `check`), with the knowledge base's name. Throws a `Refused` with what to do. */
  check(sessionId: string, draft: ProposalDraft): Promise<CheckedProposal & { base: string }>;
  /** Open the pull request for the text the user was shown. Throws a `Refused` with the host's reason. */
  open(id: string, isUpdate: boolean, text: string, reason: string): Promise<{ url: string }>;
  /** Stop proposals: the user's "Don't ask again". */
  never(): Promise<void>;
}

const BUTTONS = [
  { id: 'open', label: 'Open pull request', primary: true },
  { id: 'deny', label: 'Not now' },
  { id: 'never', label: 'Don’t ask again' },
];

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The entry as the card shows it: where it goes, who it applies to, then the text itself. */
function detailOf(checked: CheckedProposal): string {
  const { entry } = checked;
  const scope = entry.scope === 'all' ? 'every repository' : entry.scope.join(', ');
  return [`\`${entryPath(checked.id)}\` · applies to ${scope} · owner ${entry.owner}`, '', `### ${entry.title}`, '', `*${entry.summary}*`, '', entry.body].join('\n');
}

export function knowledgeKind(deps: KnowledgeKindDeps): SuggestionKind {
  return {
    kind: KNOWLEDGE_KIND,
    dismiss: 'deny',
    async propose(ctx, payload): Promise<Proposal> {
      const title = str(payload.title), summary = str(payload.summary), body = str(payload.body);
      if (!title || !summary || !body) return { type: 'refuse', reason: 'Give a title, a one-line summary and a body.' };
      const appliesTo = payload.applies_to === 'here' ? 'here' : 'everywhere';
      const earlier = ctx.messages.flatMap((m) => (m.suggestion?.kind === KNOWLEDGE_KIND ? [m.suggestion] : []));
      if (earlier.length >= PROPOSALS_PER_SESSION) return { type: 'skip', text: `This session has proposed ${PROPOSALS_PER_SESSION} entries already, which is the most one session may. Nothing was shown. Carry on.` };
      let checked: CheckedProposal & { base: string };
      try {
        checked = await deps.check(ctx.sessionId, { title, summary, body, appliesTo, ...(str(payload.area) ? { area: str(payload.area) } : {}), ...(str(payload.updates) ? { updates: str(payload.updates) } : {}) });
      } catch (error) {
        return { type: 'refuse', reason: error instanceof Error ? error.message : String(error) };
      }
      if (earlier.some((e) => e.payload.id === checked.id)) return { type: 'skip', text: 'The user has already been asked about that entry. Carry on.' };
      const reason = str(payload.reason);
      return {
        type: 'show',
        draft: {
          title: checked.isUpdate ? `Propose this correction to ${checked.base}?` : `Propose adding this to ${checked.base}?`,
          ...(reason ? { reason } : {}),
          detail: detailOf(checked),
          payload: { id: checked.id, isUpdate: checked.isUpdate, text: checked.text, title: checked.entry.title, reason },
          buttons: BUTTONS,
        },
      };
    },
    async press(_ctx, suggestion, button): Promise<Pressed> {
      const { id, isUpdate, text, title, reason } = suggestion.payload as { id: string; isUpdate: boolean; text: string; title: string; reason: string };
      if (button === 'deny') return { state: 'dismissed', line: `Did not propose “${title}”` };
      if (button === 'never') {
        await deps.never();
        return { state: 'dismissed', line: `Did not propose “${title}”, and won’t ask again (Settings → Workflow → Knowledge base)` };
      }
      if (button !== 'open') throw new Error(`A knowledge suggestion has no button "${button}".`);
      const { url } = await deps.open(id, isUpdate, text, reason);
      return { state: 'answered', line: `Opened a pull request for “${title}”`, link: url };
    },
  };
}
