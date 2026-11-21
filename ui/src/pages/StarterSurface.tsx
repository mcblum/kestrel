// The first-session starter: describe a task, choose where it runs, start. Unlike the New session
// tab it begins the session straight away and opens it.
import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { startingControls, useTabs } from '../tabsStore.ts';
import { ProjectPicker } from '../components/ProjectPicker.tsx';
import { actions } from '../store.ts';
import { useStartBase } from '../components/StartBaseDialog.tsx';
import { openSession } from '../route.ts';

export function StarterSurface() {
  const defaults = useTabs(startingControls);
  const [text, setText] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const startBase = useStartBase();
  const start = async () => {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setBusy(true);
    const where = await startBase.ask(projectId, null);
    if (!where) return setBusy(false);
    const created = await actions.createSession({ ...defaults, prompt, projectId, groupId: null, ...where });
    setBusy(false);
    if (!created) return;
    setText('');
    openSession(created.id); // in place of the page it was started from
  };
  return (
    <section className="starter" aria-label="Start a session">
      <textarea
        aria-label="Describe your task"
        placeholder="Describe a task, or an idea to explore…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void start();
          }
        }}
      />
      <div className="starter-row">
        <div className="starter-where">
          <span className="ctl-label">Project</span>
          <ProjectPicker value={projectId} onSelect={setProjectId} />
        </div>
        <button className="primary-button" disabled={!text.trim() || busy} onClick={() => void start()}>
          {busy ? 'Starting…' : 'Start session'} <ArrowRight aria-hidden />
        </button>
      </div>
      {startBase.dialog}
    </section>
  );
}
