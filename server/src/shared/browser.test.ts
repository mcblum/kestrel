import { describe, expect, it } from 'vitest';
import { addressFromInput, appendConsole, checkBrowserUrl, consoleLevel, isLoopbackHost, type ConsoleEntry } from './browser.ts';

const guard = { serverPort: 4317, appOrigins: ['http://127.0.0.1:5173', 'http://localhost:5173'] };

describe('which addresses the browser pane opens', () => {
  it('opens http and https addresses, normalized', () => {
    expect(checkBrowserUrl('https://example.com', guard)).toEqual({ ok: true, url: 'https://example.com/' });
    expect(checkBrowserUrl(' http://localhost:3000/a?b=1 ', guard)).toEqual({ ok: true, url: 'http://localhost:3000/a?b=1' });
  });

  it.each([
    ['file:///etc/passwd', /file: addresses/],
    ['javascript:alert(1)', /javascript: addresses/],
    ['data:text/html,<h1>hi</h1>', /data: addresses/],
    ['chrome://settings', /chrome: addresses are not opened/],
    ['ftp://example.com', /only http and https/],
    ['example.com', /not a full address/],
  ])('refuses %s with a reason', (url, reason) => {
    const result = checkBrowserUrl(url, guard);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(reason);
  });

  it.each(['http://127.0.0.1:4317/api/state', 'http://localhost:4317/', 'http://[::1]:4317/ws', 'http://0.0.0.0:4317/', 'http://127.1.2.3:4317/'])("refuses Kestrel's own server at %s", (url) => {
    expect(checkBrowserUrl(url, guard)).toMatchObject({ ok: false, reason: expect.stringMatching(/Kestrel's own server/) });
  });

  it("refuses the origins Kestrel's interface is served from", () => {
    expect(checkBrowserUrl('http://127.0.0.1:5173/#/settings', guard)).toMatchObject({ ok: false, reason: expect.stringMatching(/own interface/) });
  });

  // Found live: the UI was served from 127.0.0.1:5173 and http://localhost:5173 loaded it, token and all.
  it.each(['http://localhost:5173/', 'http://[::1]:5173/', 'http://0.0.0.0:5173/', 'https://127.0.0.1:5173/', 'http://app.localhost:5173/'])(
    'refuses the interface under another name for this computer: %s',
    (url) => {
      expect(checkBrowserUrl(url, { appOrigins: ['http://127.0.0.1:5173'] })).toMatchObject({ ok: false, reason: expect.stringMatching(/own interface/) });
    },
  );

  it('does not widen a non-loopback app origin to other hosts', () => {
    expect(checkBrowserUrl('http://localhost:443/', { appOrigins: ['https://kestrel.example.com'] }).ok).toBe(true);  });

  it('opens the same port on another host, and other ports on this computer', () => {
    expect(checkBrowserUrl('https://example.com:4317/', guard).ok).toBe(true);
    expect(checkBrowserUrl('http://127.0.0.1:4318/', guard).ok).toBe(true);
  });

  it('knows which hosts are this computer', () => {
    expect(['localhost', 'app.localhost', '127.0.0.1', '[::1]', '0.0.0.0'].every(isLoopbackHost)).toBe(true);
    expect(['example.com', '10.0.0.1', 'localhost.example.com'].some(isLoopbackHost)).toBe(false);
  });
});

describe('the address field', () => {
  it('adds https to a host, and http to this computer', () => {
    expect(addressFromInput('example.com/path')).toBe('https://example.com/path');
    expect(addressFromInput('localhost:5173')).toBe('http://localhost:5173');
    expect(addressFromInput('127.0.0.1/x')).toBe('http://127.0.0.1/x');
    expect(addressFromInput('devbox:8080')).toBe('http://devbox:8080');
  });

  it('keeps a scheme that is there, and never makes a search', () => {
    expect(addressFromInput('http://example.com')).toBe('http://example.com');
    expect(addressFromInput('file:///tmp/x')).toBe('file:///tmp/x');
    expect(addressFromInput('cats')).toBe('https://cats');
    expect(addressFromInput('  ')).toBe('');
  });
});

describe('console entries', () => {
  it('names Chromium levels given as numbers or words', () => {
    expect([0, 1, 2, 3, 'error', 'warning', 'info', 'verbose', undefined].map(consoleLevel)).toEqual(['debug', 'info', 'warning', 'error', 'error', 'warning', 'info', 'debug', 'info']);
  });

  it('keeps only the newest, without changing the list it was given', () => {
    const entry = (n: number): ConsoleEntry => ({ level: 'info', text: String(n), at: n });
    const list = [entry(1), entry(2), entry(3)];
    const next = appendConsole(list, entry(4), 3);
    expect(next.map((e) => e.text)).toEqual(['2', '3', '4']);
    expect(list).toHaveLength(3);
  });
});
