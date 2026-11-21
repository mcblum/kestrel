// What a command row is called in the Commands pane and the background-task list. taskName
// (background-tasks.ts) makes a short name from the words of a command ("pnpm dev (@app/api)"),
// which reads well for a plain command but cuts shell syntax in half: `for i in $(seq 1 10); do …`
// became "for i in $(seq". When the short name would do that, the row is called by the command's
// whole first line instead, clipped at the same length with an ellipsis. Pure.
import { clipEnd, NAME_MAX_CHARS, taskCommand, taskName, type BackgroundTask } from './background-tasks.ts';

/** A loop or condition, a subshell or group, a function: a name from its first words means nothing. */
const COMPOUND_START = /^(?:for|while|until|if|case|select|function|\(|\{)(?:\s|$)|^[({]/;
const count = (text: string, char: string) => text.split(char).length - 1;

/** Whether a short name stops inside shell syntax: a compound command, or an unclosed `$(`, `(` or backtick. */
export function cutInShell(name: string): boolean {
  if (COMPOUND_START.test(name)) return true;
  return count(name, '(') > count(name, ')') || count(name, '`') % 2 === 1;
}

/** The row's name: taskName, or the command's first line when taskName would cut shell syntax. */
export function taskRowName(task: BackgroundTask): string {
  const name = taskName(task);
  if (task.label?.trim() || !cutInShell(name)) return name;
  const command = taskCommand(task);
  const firstLine = command?.split('\n').find((line) => line.trim());
  return firstLine ? clipEnd(firstLine, NAME_MAX_CHARS) : name;
}
