// "Where should this session start?" (server: shared/start-base.ts, start-base/api.ts). Asked when
// Start session is pressed in a project whose checkout is not on its default branch, before the
// session exists. The latest default branch is chosen first; the answer can be remembered for the
// project (the project's Settings tab → General → New sessions start from).
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Check, CornerDownLeft, GitBranch } from 'lucide-react';
import { BASE_CHOICES, BASE_CHOICE_LABEL, describeBaseQuestion, type BaseChoice, type BaseQuestion } from '@kestrel/server/start-base';
import { call } from '../store.ts';
import { DialogShell } from './DialogShell.tsx';

/** What the session is started with: nothing extra when there was nothing to ask. */
export type BaseAnswer = { base?: BaseChoice; rememberBase?: boolean };

function StartBaseDialog({ question, onAnswer, onCancel }: { question: BaseQuestion; onAnswer: (answer: BaseAnswer) => void; onCancel: () => void }) {
  const [choice, setChoice] = useState<BaseChoice>('default');
  const [remember, setRemember] = useState(false);
  const { summary, notes } = describeBaseQuestion(question);
  const actions = (
    <button type="button" className="pr-merge-confirm" data-autofocus onClick={() => onAnswer({ base: choice, rememberBase: remember })}>
      <CornerDownLeft size={15} aria-hidden />
      Start session
    </button>
  );
  return (
    <DialogShell icon={<GitBranch size={20} aria-hidden />} eyebrow="NEW SESSION" title="Where should this session start?" busy={false} onClose={onCancel} actions={actions}>
      <p className="pr-merge-title">{summary}</p>
      {notes.map((note) => <p key={note} className="pr-merge-note start-base-note">{note}</p>)}
      <fieldset className="pr-merge-method">
        <legend>Start from</legend>
        {BASE_CHOICES.map((c) => (
          <label key={c} className={`pr-merge-option${choice === c ? ' selected' : ''}`}>
            <input type="radio" name="start-base" value={c} checked={choice === c} onChange={() => setChoice(c)} />
            <span>{BASE_CHOICE_LABEL(c, question)}</span>
            {c === 'default' && <span className="start-base-hint">Recommended</span>}
            {choice === c && <Check size={15} aria-hidden />}
          </label>
        ))}
      </fieldset>
      <label className="tag-rule-switch start-base-remember">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Remember for {question.projectName}
      </label>
    </DialogShell>
  );
}

/**
 * Asks where a new session starts, when there is anything to ask. `ask` resolves with what to start
 * the session with, or null when the user cancelled. A server that cannot answer (an older one, or
 * an error) is not asked again: the session starts as it always did.
 */
export function useStartBase(): { ask: (projectId: string | null, folderId: string | null) => Promise<BaseAnswer | null>; dialog: ReactNode } {
  const [question, setQuestion] = useState<BaseQuestion | null>(null);
  const settle = useRef<((answer: BaseAnswer | null) => void) | null>(null);
  const ask = useCallback(async (projectId: string | null, folderId: string | null): Promise<BaseAnswer | null> => {
    if (!projectId) return {};
    const checked = await call<{ question: BaseQuestion | null }>('/api/start-base/check', { method: 'POST', body: JSON.stringify({ projectId, folderId }) }).catch(() => null);
    if (!checked?.question) return {};
    const shown = checked.question;
    return new Promise<BaseAnswer | null>((resolve) => {
      settle.current = resolve;
      setQuestion(shown);
    });
  }, []);
  const finish = (answer: BaseAnswer | null) => {
    settle.current?.(answer);
    settle.current = null;
    setQuestion(null);
  };
  const dialog = question && <StartBaseDialog question={question} onAnswer={finish} onCancel={() => finish(null)} />;
  return { ask, dialog };
}
