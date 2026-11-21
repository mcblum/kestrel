import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThinkingMark } from '../components/ThinkingMark.tsx';
import { WorkingFoot } from '../components/TurnFoot.tsx';
import '../styles/prototype.css';
import '../styles/tokens.css';
import '../styles/app.css';
import '../styles/turn-foot.css';
function Preview() {
  const [step, setStep] = useState(0);
  const phrases = ['Thinking…', 'Reading the code…', 'Checking an approach…', 'Putting it together…'];
  const status = phrases[step % phrases.length]!;
  return <main className="kestrel" style={{colorScheme:'dark',minHeight:'100vh',padding:48,boxSizing:'border-box',background:'var(--s-bg)'}}>
    <h1 style={{fontSize:22}}>Thinking animation</h1><p style={{color:'var(--s-muted)'}}>The intro’s blue Git lines, condensed into a branching wing.</p>
    <section style={{padding:'32px 0'}}><WorkingFoot text={status} /><button onClick={() => setStep(n => n + 1)}>Next activity →</button></section>
    <section style={{position:'relative',height:100,borderTop:'1px solid var(--s-line)'}}><button className="to-bottom working" aria-label="Work happening below · preview"><ThinkingMark status={status} /></button></section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
