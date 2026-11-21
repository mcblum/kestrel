import { describe, expect, it } from 'vitest';
import { timedSteps } from './shutdown.ts';

describe('timedSteps', () => {
  it('runs the steps in order and says how long each took', async () => {
    let t = 0;
    const order: string[] = [];
    const told = await timedSteps(
      [
        ['agents', async () => (order.push('agents'), (t += 12))],
        ['http', () => (order.push('http'), (t += 3))],
        ['store', () => void order.push('store')],
      ],
      () => t,
    );
    expect(order).toEqual(['agents', 'http', 'store']);
    expect(told).toBe('agents 12ms, http 3ms, store 0ms');
  });

  it('notes a step that fails and carries on with the rest', async () => {
    let t = 0;
    const ran: string[] = [];
    const told = await timedSteps(
      [
        ['agents', async () => { t += 5; throw new Error('would not stop'); }],
        ['http', () => void ran.push('http')],
      ],
      () => t,
    );
    expect(ran).toEqual(['http']);
    expect(told).toBe('agents failed after 5ms: would not stop, http 0ms');
  });
});
