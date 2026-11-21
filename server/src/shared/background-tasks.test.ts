// Background work listed at the foot of a session: kind wording, first-seen times, elapsed text, truncation, readable names.
import { describe, expect, it } from 'vitest';
import { backgroundKind, commandName, elapsedText, looksLikeCommand, middleTruncate, NAME_MAX_CHARS, splitCommand, taskCommand, taskName, taskText, withFirstSeen, type LiveBackgroundTask } from './background-tasks.ts';

const MINUTE = 60_000;

describe('background task kinds', () => {
  it('names commands, watchers, workflows and tool calls in plain words', () => {
    expect(backgroundKind('local_bash')).toBe('command');
    expect(backgroundKind('monitor')).toBe('watcher');
    expect(backgroundKind('local_workflow')).toBe('workflow');
    expect(backgroundKind('mcp_task')).toBe('tool');
  });
  it('leaves helpers out (they have their own card) and keeps anything unknown as other', () => {
    expect(backgroundKind('local_agent')).toBeNull();
    expect(backgroundKind('something_new')).toBe('other');
  });
  it('describes a task with no description by its kind', () => {
    expect(taskText({ id: 'a', kind: 'command', description: '  ' })).toBe('Command running in the background');
    expect(taskText({ id: 'a', kind: 'watcher', description: 'Watch CI' })).toBe('Watch CI');
  });
});

describe('when each task was first seen', () => {
  it('keeps the time of a task already listed and stamps a new one now', () => {
    const before: LiveBackgroundTask[] = [{ id: 'a', kind: 'command', description: 'tests', since: 100 }];
    const after = withFirstSeen(before, [{ id: 'a', kind: 'command', description: 'tests' }, { id: 'b', kind: 'watcher', description: 'CI' }], 500);
    expect(after).toEqual([
      { id: 'a', kind: 'command', description: 'tests', since: 100 },
      { id: 'b', kind: 'watcher', description: 'CI', since: 500 },
    ]);
  });
  it('drops a task that is no longer listed', () => {
    expect(withFirstSeen([{ id: 'a', kind: 'command', description: 'x', since: 1 }], [], 2)).toEqual([]);
  });
});

describe('how long it has been running', () => {
  it('says under a minute, minutes, and hours with minutes', () => {
    expect(elapsedText(0, 59_999)).toBe('<1m');
    expect(elapsedText(0, 4 * MINUTE + 10)).toBe('4m');
    expect(elapsedText(0, 65 * MINUTE)).toBe('1h 5m');
    expect(elapsedText(0, 120 * MINUTE)).toBe('2h');
  });
  it('reads a clock running behind as under a minute', () => {
    expect(elapsedText(1_000, 0)).toBe('<1m');
  });
});

describe('cutting a long description in the middle', () => {
  it('leaves a short one alone, collapsing its spaces', () => {
    expect(middleTruncate('pnpm   test\n--watch', 40)).toBe('pnpm test --watch');
  });
  it('keeps the start and the end of a long one', () => {
    const cut = middleTruncate('pnpm --filter @kestrel/server exec vitest run src/runtime.test.ts', 20);
    expect(cut).toHaveLength(20);
    expect(cut.startsWith('pnpm --fi')).toBe(true);
    expect(cut.endsWith('.test.ts')).toBe(true);
    expect(cut).toContain('…');
  });
  it('never goes over the limit, even a tiny one', () => {
    expect(middleTruncate('abcdef', 1)).toBe('…');
  });
});

describe('a readable name for a command', () => {
  it('keeps the program and its first plain words, dropping flags and their values', () => {
    expect(commandName('docker compose up -d db')).toBe('docker compose up db');
    expect(commandName('npx vite --port 5173 --host')).toBe('npx vite');
    expect(commandName('npm run dev')).toBe('npm run dev');
  });
  it('names the package a package manager runs in', () => {
    expect(commandName('pnpm --filter @app/api dev')).toBe('pnpm dev (@app/api)');
    expect(commandName('pnpm --filter=@kestrel/server exec vitest run')).toBe('pnpm exec vitest run (@kestrel/server)');
    expect(commandName('npm run dev --workspace api')).toBe('npm run dev (api)');
  });
  it('finds the main command of a pipeline with setup and logging around it', () => {
    expect(commandName('cd services/api && PORT=4000 pnpm --filter @app/api dev 2>&1 | tee /tmp/api.log')).toBe('pnpm dev (@app/api)');
    expect(commandName('export NODE_ENV=development; nohup node ./server/index.js > /tmp/server.log 2>&1 &')).toBe('node index.js');
    expect(commandName('cd ui\nenv -i FOO=1 yarn start')).toBe('yarn start');
  });
  it('only ever uses words that are in the command', () => {
    const command = 'cd x && FOO="a b" python -m http.server 8000 >> "/tmp/my log.txt"';
    const words = new Set(command.split(/[\s"'=&>]+/));
    expect(commandName(command)).toBe('python http.server');
    for (const word of commandName(command).split(' ')) expect(words.has(word)).toBe(true);
  });
  it('takes quotes off as the shell does and keeps a quoted argument as one word', () => {
    expect(splitCommand(`git commit -m "fix: a b" && echo 'done; really'`)).toEqual([['git', 'commit', '-m', 'fix: a b'], ['echo', 'done; really']]);
  });
  it('falls back to a setup command when that is all there is, and is empty for nothing', () => {
    expect(commandName('sleep 30')).toBe('sleep');
    expect(commandName('   ')).toBe('');
  });
  it('caps the length', () => {
    const name = commandName(`./bin/${'x'.repeat(80)} serve`);
    expect(name.length).toBe(NAME_MAX_CHARS);
    expect(name.endsWith('…')).toBe(true);
  });
});

describe('what a row is called', () => {
  const shell = { id: 'b1', kind: 'command' as const };
  it("uses the agent's own words for the call first, with the full command beside it", () => {
    const task = { ...shell, description: 'pnpm --filter @app/api dev', label: 'Start the API dev server', command: 'pnpm --filter @app/api dev' };
    expect(taskName(task)).toBe('Start the API dev server');
    expect(taskCommand(task)).toBe('pnpm --filter @app/api dev');
  });
  it('makes a name from the command when the agent gave none', () => {
    const task = { ...shell, description: 'cd api && pnpm dev | tee log' };
    expect(taskName(task)).toBe('pnpm dev');
    expect(taskCommand(task)).toBe('cd api && pnpm dev | tee log');
  });
  it('shows a description written for people as it is, with no command line', () => {
    const task = { id: 'w', kind: 'watcher' as const, description: 'Watch CI until it goes green' };
    expect(taskName(task)).toBe('Watch CI until it goes green');
    expect(taskCommand(task)).toBeNull();
    expect(taskName({ ...shell, description: 'Run the full test suite' })).toBe('Run the full test suite');
  });
  it('shows no second line when the command says no more than the name', () => {
    expect(taskCommand({ ...shell, description: 'npm run dev' })).toBeNull();
  });
  it('falls back to the kind when there is nothing to go on', () => {
    expect(taskName({ ...shell, description: ' ' })).toBe('Command running in the background');
  });
  it('tells a command line from words for people', () => {
    expect(looksLikeCommand('PORT=1 pnpm dev')).toBe(true);
    expect(looksLikeCommand('./scripts/dev.sh')).toBe(true);
    expect(looksLikeCommand('Watch CI')).toBe(false);
  });
});
