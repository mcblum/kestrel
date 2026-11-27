import { describe, expect, test } from 'vitest';
import type { ServiceState } from '../shared/node-service.ts';
import { startPlan, stopPlan, unitAction } from './service.ts';

const running: ServiceState = { manager: 'systemd', installed: true, active: true, mainPid: 10 };
const stopped: ServiceState = { manager: 'systemd', installed: true, active: false, mainPid: null };

describe('startPlan', () => {
  test('an installed, stopped service is started through systemctl', () => {
    expect(startPlan(stopped, false)).toEqual({ do: 'systemctl' });
  });

  test('a running service needs nothing', () => {
    expect(startPlan(running, true)).toEqual({ do: 'nothing', text: 'kestrel-node.service is running already.' });
  });

  test('no user manager, no unit, or a node run by hand is refused with what to do instead', () => {
    expect(startPlan({ manager: 'none' }, false)).toMatchObject({ do: 'refuse', reason: expect.stringContaining('kestrel-node run') });
    expect(startPlan({ manager: 'systemd', installed: false }, false)).toMatchObject({ do: 'refuse', reason: expect.stringContaining('Run the install again') });
    expect(startPlan(stopped, true)).toMatchObject({ do: 'refuse', reason: expect.stringContaining('started by hand is running') });
  });
});

describe('stopPlan', () => {
  test('through systemd when it runs the node, so it is not started again', () => {
    expect(stopPlan(running, true)).toEqual({ do: 'systemctl' });
  });

  test('over the socket for a node started by hand, with or without a unit', () => {
    expect(stopPlan(stopped, true)).toEqual({ do: 'socket' });
    expect(stopPlan({ manager: 'none' }, true)).toEqual({ do: 'socket' });
  });

  test('nothing running is nothing to stop', () => {
    expect(stopPlan(stopped, false)).toEqual({ do: 'nothing', text: 'No worker node is running here.' });
  });
});

describe('unitAction', () => {
  test('asks systemctl --user for the unit and words the outcome', async () => {
    const asked: string[][] = [];
    const ok = await unitAction('start', async (args) => (asked.push([...args]), { ok: true, error: '' }));
    expect(asked).toEqual([['start', 'kestrel-node.service']]);
    expect(ok).toEqual({ ok: true, line: 'Started kestrel-node.service. "kestrel-node status" says how it is.' });
    expect(await unitAction('stop', async () => ({ ok: false, error: 'Unit not loaded.' }))).toEqual({ ok: false, line: 'systemctl --user stop kestrel-node.service failed: Unit not loaded.' });
  });
});
