// The notification sounds (server: shared/notifications.ts), made with the browser's own audio:
// no sound files to ship. Each is short and quiet. A browser that will not start audio (no user
// gesture yet) simply plays nothing.
import type { SoundId } from '@kestrel/server/notifications';

/** One note: its pitch (Hz; a pair slides from the first to the second), when it starts and how long it rings (seconds). */
interface Note {
  from: number;
  to?: number;
  at: number;
  ring: number;
}

const SCORES: Record<Exclude<SoundId, 'none'>, Note[]> = {
  chime: [{ from: 659.25, at: 0, ring: 0.5 }, { from: 880, at: 0.14, ring: 0.7 }],
  ping: [{ from: 1046.5, at: 0, ring: 0.35 }],
  pop: [{ from: 420, to: 160, at: 0, ring: 0.12 }],
};
const VOLUME = 0.12;

let context: AudioContext | null = null;

export function playSound(sound: SoundId): void {
  if (sound === 'none' || typeof AudioContext === 'undefined') return;
  try {
    context ??= new AudioContext();
    const audio = context;
    void audio.resume().catch(() => undefined);
    for (const note of SCORES[sound]) {
      const start = audio.currentTime + note.at;
      const tone = audio.createOscillator();
      const level = audio.createGain();
      tone.type = 'sine';
      tone.frequency.setValueAtTime(note.from, start);
      if (note.to) tone.frequency.exponentialRampToValueAtTime(note.to, start + note.ring);
      level.gain.setValueAtTime(0.0001, start);
      level.gain.exponentialRampToValueAtTime(VOLUME, start + 0.01);
      level.gain.exponentialRampToValueAtTime(0.0001, start + note.ring);
      tone.connect(level).connect(audio.destination);
      tone.start(start);
      tone.stop(start + note.ring + 0.02);
    }
  } catch {
    // no audio device, or the browser refused: a missing sound is not worth an error
  }
}
