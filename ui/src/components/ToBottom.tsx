// "Go to the latest", just above the message box while the reader has scrolled up: the bird while the agent is
// still working below, a chevron once it has finished. One for a session here and one on another computer.
import { ChevronDown } from 'lucide-react';
import { ThinkingMark } from './ThinkingMark.tsx';

interface Props {
  away: boolean;
  running: boolean;
  workingText: string;
  /** The message box's height: the button sits just above it. */
  composerHeight: number;
  onClick: () => void;
}

export function ToBottom({ away, running, workingText, composerHeight, onClick }: Props) {
  return (
    <div className="to-bottom-anchor" style={{ bottom: composerHeight }}>
      {away && (
        <button className={`to-bottom${running ? ' working' : ''}`} aria-label={running ? 'The agent is working below. Go to the latest' : 'Go to the latest'} onClick={onClick}>
          {running ? <ThinkingMark status={workingText} /> : <ChevronDown aria-hidden />}
        </button>
      )}
    </div>
  );
}
