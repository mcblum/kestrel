// What a worker node publishes for its page: the status facts in words, from the same value `status` prints.
import { describe, expect, test } from 'vitest';
import { asNodeFacts, asNodePublished, FACT_MAX, nodeFactsOf } from './node-facts.ts';
import { statusFor } from './node-status-fixture.ts';

describe('nodeFactsOf', () => {
  test('words each fact the page shows, without its label', () => {
    const facts = nodeFactsOf(statusFor({ canRun: ['claude'] }));
    expect(facts.agents.claude).toBe('Can run');
    expect(facts.agents.codex).toBe('Not available.');
    expect(facts.sandbox).toBe('Available');
    expect(facts.lingering).toContain('On:');
    expect(facts.freeDisk).toBe('9.3 GB free.');
    expect(facts.git.startsWith('Git:')).toBe(false);
    expect(facts.projects).toBe('Not read yet.');
  });

  test('says no path and no user name the status would not', () => {
    const json = JSON.stringify(nodeFactsOf(statusFor({ lingering: 'off', sandbox: false })));
    expect(json).not.toContain('/home/node');
    expect(json).not.toContain('nodeuser');
    expect(json).toContain('kestrel node configure');
  });

  test('a long projects line is cut, so the record stays small', () => {
    const status = statusFor();
    const many = { here: 1, notHere: 400, cloning: 0, mode: 'every' as const, notCloned: Array.from({ length: 400 }, (_, i) => ({ name: `Project ${i}`, why: 'The key cannot read it.' })), kept: [], lowDisk: null, where: '~/.kestrel/projects' };
    const facts = nodeFactsOf({ ...status, projects: many });
    expect(facts.projects.length).toBe(FACT_MAX);
    expect(asNodeFacts(facts)).toEqual(facts);
  });
});

describe('asNodePublished', () => {
  test('needs both its settings and its facts', () => {
    const facts = nodeFactsOf(statusFor());
    const settings = { name: 'Worker node 1', remoteStarts: true, agent: 'claude', model: '', mode: 'ask', autoReviews: false, projects: 'every', push: true, followDesktopVersion: true };
    expect(asNodePublished({ settings, facts })).toEqual({ settings, facts });
    expect(asNodePublished({ settings })).toBeNull();
    expect(asNodePublished({ settings, facts: { ...facts, git: 'x'.repeat(FACT_MAX + 1) } })).toBeNull();
  });
});
