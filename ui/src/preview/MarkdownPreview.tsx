import { useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { Markdown } from '../components/Markdown.tsx';
import conversation from './conversation.md?raw';
import elements from './elements.md?raw';
import tables from './tables.md?raw';
import '../styles/prototype.css';
import '../styles/tokens.css';
import '../styles/app.css';
import './preview.css';

function MarkdownPreview() {
  const [theme, setTheme] = useState('dark');
  const [width, setWidth] = useState('conversation');
  const [sample, setSample] = useState(new URLSearchParams(location.search).get('sample') === 'tables' ? 'tables' : 'conversation');
  const [custom, setCustom] = useState(conversation);
  const text = sample === 'custom' ? custom : sample === 'elements' ? elements : sample === 'tables' ? tables : conversation;
  return (
    <div className="kestrel markdown-studio" style={{ colorScheme: theme === 'system' ? 'light dark' : theme } as CSSProperties}>
      <header className="specimen-toolbar">
        <div className="specimen-brand"><strong>Kestrel</strong><span>Markdown studio</span></div>
        <div className="specimen-controls">
          <label>Appearance<select value={theme} onChange={e => setTheme(e.target.value)}><option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option></select></label>
          <label>Column<select value={width} onChange={e => setWidth(e.target.value)}><option value="conversation">Conversation · 690px</option><option value="narrow">Narrow · 360px</option></select></label>
        </div>
      </header>
      <main className="specimen-main">
        <div className="specimen-intro">
          <p className="specimen-kicker">THE READING EXPERIENCE</p>
          <h1>Room for the details.</h1>
          <p>Real conversation styles. Every element, in context.</p>
          <div className="specimen-tabs" role="group" aria-label="Markdown sample">
            {([['conversation', 'Conversation'], ['elements', 'All elements'], ['tables', 'Tables'], ['custom', 'Your Markdown']] as const).map(([value, label]) => <button key={value} aria-pressed={sample === value} onClick={() => setSample(value)}>{label}</button>)}
          </div>
        </div>
        {sample === 'custom' && <label className="specimen-editor">Try your own Markdown<textarea value={custom} onChange={e => setCustom(e.target.value)} spellCheck={false} /></label>}
        <section className={`specimen-sheet specimen-${width}`} aria-label="Rendered Markdown">
          <div className="specimen-message-label"><span className="specimen-dot" /> Kestrel <span> / {sample === 'elements' ? 'Typography specimen' : 'Conversation preview'}</span></div>
          <div className="chat-text prose"><Markdown text={text} /></div>
        </section>
        <footer className="specimen-footer">Shared with the app’s conversation renderer · CommonMark + GitHub Flavored Markdown</footer>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<MarkdownPreview />);
