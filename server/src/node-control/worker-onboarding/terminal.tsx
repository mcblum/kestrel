import { stripVTControlCharacters } from 'node:util';
import { render } from 'ink';
import React from 'react';
import type { WorkerAnswer, WorkerFrame, WorkerPrompt } from './model.ts';
import { workerPalette, type WorkerPalette } from './palette.ts';
import { WorkerScreen } from './screen.tsx';

export interface WorkerTerminal {
  /** Replace the active frame. Earlier frames do not accumulate in scrollback. */
  show(frame: WorkerFrame): void;
  /** Sole keyboard consumer while active. Null means Escape, Ctrl+C, or terminal closure. */
  ask(prompt: WorkerPrompt): Promise<WorkerAnswer>;
  /** Release the keyboard and cursor before running a program that uses the terminal. */
  handoff<T>(notice: string, run: () => Promise<T>): Promise<T>;
  /** Render a final frame and leave it above the shell prompt. */
  finish(frame: WorkerFrame): Promise<void>;
  /** Release terminal state and resolve any outstanding question after interruption. */
  close(): Promise<void>;
}

interface WorkerTerminalOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  palette?: WorkerPalette;
  onCancel: () => void;
}

/** Call only for a live Ink session. The caller owns signals, sockets and subprocess cancellation. */
export function openWorkerTerminal(initial: WorkerFrame, options: WorkerTerminalOptions): WorkerTerminal {
  const { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = options;
  const palette = options.palette ?? workerPalette(process.env);
  let frame = initial;
  let live = true;
  let handedOff = false;
  let instance: ReturnType<typeof render> | undefined;
  let question: { prompt: WorkerPrompt; resolve: (answer: WorkerAnswer) => void } | undefined;

  const settle = (answer: WorkerAnswer) => {
    const pending = question;
    question = undefined;
    pending?.resolve(answer);
  };

  const onAnswer = (answer: WorkerAnswer) => {
    settle(answer);
    paint();
  };

  const onCancel = () => {
    if (!live) return;
    options.onCancel();
    void close();
  };

  function paint() {
    if (handedOff) return;
    const view = <WorkerScreen frame={frame} prompt={question?.prompt} palette={palette} live={live} onAnswer={onAnswer} onCancel={onCancel} />;
    if (instance) instance.rerender(view);
    else instance = render(view, { stdin, stdout, stderr, exitOnCtrlC: false, patchConsole: false });
  }

  async function unmount(erase: boolean) {
    const mounted = instance;
    instance = undefined;
    if (!mounted) return;
    if (erase) mounted.rerender(null);
    const done = mounted.waitUntilExit();
    mounted.unmount();
    await done;
    // A detached readable listener can leave Node's pending terminal read active.
    // Pause it before either a child program or the shell takes the keyboard.
    stdin.pause();
  }

  // Ctrl+C closes from inside, and the command closes again before it writes: both wait for the one release.
  let closing: Promise<void> | undefined;
  function close() {
    closing ??= (async () => {
      live = false;
      settle(null);
      await unmount(true);
    })();
    return closing;
  }

  paint();
  return {
    show(next) {
      if (!live) return;
      frame = next;
      paint();
    },
    async ask(prompt) {
      if (!live) return null;
      if (question || handedOff) throw new Error('The terminal already has an input owner.');
      return new Promise((resolve) => {
        question = { prompt, resolve };
        paint();
      });
    },
    async handoff(notice, run) {
      if (question || handedOff) throw new Error('The terminal already has an input owner.');
      handedOff = true;
      try {
        await unmount(true);
        // The notice stays with the provider's output and uses the terminal's own palette.
        const text = stripVTControlCharacters(notice).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
        if (text) stdout.write(text + '\n');
        return await run();
      } finally {
        handedOff = false;
        // The screen comes back as a new step, set off by a blank line from what the program printed.
        if (live) {
          stdout.write('\n');
          paint();
        }
      }
    },
    async finish(final) {
      if (!live) return;
      frame = final;
      live = false;
      settle(null);
      paint();
      await unmount(false);
      stdout.write('\n');
    },
    close,
  };
}
