// `kestrel node logs`: the terminal reads the node's log itself, so it works whether or not a node is running.
// Under systemd the node logs to the journal (journalctl, for the unit); started by hand it writes Kestrel's own
// log file (log-file.ts). Which one is decided purely (`logSourceOf`); reading it hands the terminal to that program.
import { spawn } from 'node:child_process';
import { NODE_UNIT_NAME, type ServiceState } from '../shared/node-service.ts';
import type { LogOptions } from './args.ts';

export type LogSource = { from: 'journal' } | { from: 'file'; path: string } | { from: 'none'; reason: string };

export interface LogFacts {
  service: ServiceState;
  /** journalctl can be run here. */
  journalctl: boolean;
  logFile: string;
  logFileExists: boolean;
}

export function logSourceOf(f: LogFacts): LogSource {
  if (f.service.manager === 'systemd' && f.service.installed && f.journalctl) return { from: 'journal' };
  if (f.logFileExists) return { from: 'file', path: f.logFile };
  return { from: 'none', reason: `No log yet: the node is not installed as a service, and nothing has been written to ${f.logFile}. A node started by hand with "kestrel node run" writes there.` };
}

/** The program and arguments that print (and, with -f, follow) the log. */
export function logCommand(source: Exclude<LogSource, { from: 'none' }>, options: LogOptions): { file: string; args: string[] } {
  if (source.from === 'journal') return { file: 'journalctl', args: ['--user', '--unit', NODE_UNIT_NAME, '--no-pager', '--output', 'short-iso', '--lines', String(options.lines), ...(options.follow ? ['--follow'] : [])] };
  return { file: 'tail', args: ['-n', String(options.lines), ...(options.follow ? ['-F'] : []), source.path] };
}

/** Runs it with the terminal's own output; resolves with its exit code. */
export function showLog(source: Exclude<LogSource, { from: 'none' }>, options: LogOptions): Promise<number> {
  const { file, args } = logCommand(source, options);
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: 'inherit' });
    child.once('error', (error) => {
      console.error(`Could not run ${file}: ${error.message}`);
      resolve(1);
    });
    child.once('exit', (code) => resolve(code ?? 0));
  });
}
