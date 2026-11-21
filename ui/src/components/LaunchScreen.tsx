import { useEffect, useState } from 'react';
import '../styles/launch.css';

// The branches draw, converge into the bird by 2s, then hold before fading over the app.
const LAUNCH_SHOWN_MS = 2600;
const LAUNCH_FADE_MS = 400; // launch-leave in launch.css

export type LaunchPhase = 'showing' | 'leaving' | 'done';

/**
 * Bellbird/Wren's arrival; the workspace loads in parallel. 'showing' until the animation has had
 * its time AND there is something to show behind it (`ready`), then 'leaving' while it fades, then 'done'.
 */
export function useLaunchPhase(ready: boolean): LaunchPhase {
  const [shown, setShown] = useState(false);
  const [faded, setFaded] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), LAUNCH_SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, []);
  const leaving = shown && ready;
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setFaded(true), LAUNCH_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  return faded ? 'done' : leaving ? 'leaving' : 'showing';
}

export function LaunchScreen({ leaving = false }: { leaving?: boolean }) {
  return (
    <div className={`kestrel launch-veil${leaving ? ' leaving' : ''}`}>
      <main className="launch-screen" role="status" aria-label="Kestrel by Matt Blum. Loading workspace." aria-busy="true">
        <div className="launch-lockup" aria-hidden="true">
          <svg className="launch-bird" viewBox="0 0 32 28" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
            {/* Matching cubic segments let Chromium morph the branch graph into the brand mark. */}
            <g transform="translate(1 2)">
              <g className="launch-mark">
                <path className="launch-contour" pathLength="1" d="M4.4 18 L13 18 C17.418 18 21 14.418 21 10 L21 7 C21 4.791 19.209 3 17 3 C15.713 3 14.504 3.619 13.72 4.7 L3 20" />
                <path className="launch-wing" pathLength="1" d="M8 18 C11.314 18 14 15.314 14 12 C14 10.16 13.16 8.49 11.84 7.39" />
                <path className="launch-fork" pathLength="1" d="M11 21 L11 18 M15 21 L15 17.75" />
              </g>
              <g className="launch-commits">
                <circle className="launch-commit launch-commit-root" cx="4.4" cy="18" r=".75" />
                <circle className="launch-commit launch-commit-head" cx="17" cy="3" r=".75" />
                <circle className="launch-commit launch-commit-wing" cx="11.84" cy="7.39" r=".75" />
                <circle className="launch-commit launch-commit-tail" cx="15" cy="21" r=".75" />
              </g>
              <path className="launch-beak" pathLength="1" d="m21 7 2 .5-2 .5" />
              <path className="launch-eye" d="M17 7h.01" />
            </g>
          </svg>
          <div className="launch-name">Kestrel</div>
          <div className="launch-credit">by Matt Blum</div>
        </div>
      </main>
    </div>
  );
}
