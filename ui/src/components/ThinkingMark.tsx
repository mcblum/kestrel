import { useEffect, useRef } from 'react';
import '../styles/thinking-mark.css';

const POSES = [
  { speed: 0, flat: 1, tilt: 0, spread: 1, wing: 1, tree: 1 },
  { speed: 1.6, flat: .8, tilt: -.45, spread: 1, wing: .12, tree: 0 },
  { speed: -1.3, flat: .3, tilt: .5, spread: 1, wing: .1, tree: 0 },
  { speed: .7, flat: .9, tilt: -.2, spread: .65, wing: .6, tree: 0 },
];

/** One uninterrupted clock. Activity changes retarget springs; they never reset positions. */
export function ThinkingMark({ status = 'Thinking…' }: { status?: string }) {
  const svg = useRef<SVGSVGElement>(null);
  const phrase = useRef(status);
  useEffect(() => { phrase.current = status; }, [status]);
  useEffect(() => {
    const root = svg.current!;
    const nodes = [...root.querySelectorAll<SVGCircleElement>('.thinking-node')];
    const wing = root.querySelector<SVGGElement>('.thinking-wing')!;
    const flows = [...root.querySelectorAll<SVGPathElement>('.thinking-flow')];
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let last = 0;
    let elapsed = 0;
    let age = 0;
    let step = 0;
    let angle = 0;
    let dash = 0;
    let seen = phrase.current;
    const pose = { ...POSES[0]! };
    const velocity = { speed: 0, flat: 0, tilt: 0, spread: 0, wing: 0, tree: 0 };
    const keys = Object.keys(pose) as (keyof typeof pose)[];
    const points = [{ x: 4, y: 6, vx: 0, vy: 0 }, { x: 20, y: 6, vx: 0, vy: 0 }, { x: 12, y: 19, vx: 0, vy: 0 }];
    const advance = () => { step += 1; age = 0; };
    const draw = (now: number) => {
      // A hidden tab resumes gently instead of integrating a large elapsed-time jump.
      const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 0;
      last = now;
      elapsed += dt;
      age += dt;
      if (seen !== phrase.current) { seen = phrase.current; advance(); }
      else if (age > 5.5 + (step % 3) * .65) advance();
      const target = POSES[step % POSES.length]!;
      // Underdamped springs retain momentum and give flattening/direction changes a soft overshoot.
      for (const key of keys) {
        velocity[key] += ((target[key] - pose[key]) * 38 - velocity[key] * 8) * dt;
        pose[key] += velocity[key] * dt;
      }
      angle += pose.speed * dt * (1 + .16 * Math.sin(elapsed * 1.7));
      dash -= dt * (.32 + .05 * Math.sin(elapsed * .9));
      const breathe = 1 + .07 * Math.sin(elapsed * 2.1);
      points.forEach((p, i) => {
        const theta = angle + [-2.5, -.65, Math.PI / 2][i]!;
        const x = Math.cos(theta) * 8 * pose.spread * breathe;
        const y = Math.sin(theta) * 8 * pose.flat * pose.spread * breathe;
        const orbitX = 12 + x * Math.cos(pose.tilt) - y * Math.sin(pose.tilt);
        const orbitY = 12 + x * Math.sin(pose.tilt) + y * Math.cos(pose.tilt);
        // Return to the same branch endpoints without resetting angle or point velocity.
        const tx = orbitX + ([4, 20, 12][i]! - orbitX) * pose.tree;
        const ty = orbitY + ([6, 6, 19][i]! - orbitY) * pose.tree;
        p.vx += ((tx - p.x) * 65 - p.vx * 10) * dt;
        p.vy += ((ty - p.y) * 65 - p.vy * 10) * dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        nodes[i]!.setAttribute('cx', String(p.x));
        nodes[i]!.setAttribute('cy', String(p.y));
        nodes[i]!.style.opacity = String(.65 + .3 * Math.sin(elapsed * 2 + i * 2));
      });
      wing.style.opacity = String(Math.max(.08, Math.min(1, pose.wing)));
      flows.forEach((flow, i) => { flow.style.strokeDashoffset = String(dash + i * .35); });
      frame = requestAnimationFrame(draw);
    };
    const start = () => {
      cancelAnimationFrame(frame);
      last = 0;
      // Keep the current pose still when reduced motion is requested, including live preference changes.
      if (!reduced.matches) frame = requestAnimationFrame(draw);
    };
    start();
    reduced.addEventListener('change', start);
    return () => { cancelAnimationFrame(frame); reduced.removeEventListener('change', start); };
  }, []);
  return <svg ref={svg} className="thinking-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <g className="thinking-wing">
      <g className="thinking-tracks">
        <path d="M12 19V14L4 10V6" />
        <path d="M12 19V14L20 10V6" />
        <path d="M12 19V5" />
      </g>
      <path className="thinking-flow" pathLength="1" d="M12 19V14L4 10V6" />
      <path className="thinking-flow" pathLength="1" d="M12 19V14L20 10V6" />
    </g>
    <circle className="thinking-node" cx="4" cy="6" r="1.3" />
    <circle className="thinking-node" cx="20" cy="6" r="1.3" />
    <circle className="thinking-node" cx="12" cy="19" r="1.3" />
  </svg>;
}
