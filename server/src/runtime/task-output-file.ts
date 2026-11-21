// The end of a background command's output, read from the file the agent said it writes to (Claude:
// `<tmp>/…/tasks/<task id>.output`, named in the call's result and in its end notice). Reading the
// file needs no answer from the agent's process, so it works while the agent is busy, quiet or gone.
// Only a file that looks like that is read: an absolute path to a regular `<name>.output` file in a
// `tasks` folder.
import { open, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';

/** Whether `path` is shaped like an agent's task output file. Pure. */
export function isTaskOutputPath(path: string): boolean {
  return isAbsolute(path) && basename(dirname(path)) === 'tasks' && /^[\w-]+\.output$/.test(basename(path));
}

/** The task id an output file is named for (`tasks/<task id>.output`), or undefined when it is not shaped like one. Pure. */
export function taskIdOfOutput(path: string): string | undefined {
  return isTaskOutputPath(path) ? basename(path).slice(0, -'.output'.length) : undefined;
}

/** The last `maxBytes` of the file as text, and whether that is only its end. Rejects with a reason. */
export async function readOutputTail(path: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!isTaskOutputPath(path)) throw new Error(`Not a task output file: ${path}`);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Not a file: ${path}`);
  const length = Math.min(info.size, maxBytes);
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, info.size - length);
    // A cut in the middle of a character would show as a replacement mark; drop up to one partial character.
    const text = buffer.toString('utf8');
    return { text: info.size > length ? text.replace(/^�+/, '') : text, truncated: info.size > length };
  } finally {
    await file.close();
  }
}
