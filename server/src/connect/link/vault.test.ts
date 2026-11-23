import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { tokensFor } from './connect-fakes.ts';
import { jwtClaims, OidcProvider, pkcePair, SignInEnded, tokensFrom } from './identity.ts';
import { listenForCallback } from './loopback.ts';
import { computerName, serviceUrl } from './start.ts';
import { EMPTY_VAULT, keyedFileVault, open, plainFileVault, seal } from './vault.ts';

const data = { tokens: tokensFor(1, 0), device: null };
const folder = () => mkdtempSync(join(tmpdir(), 'kestrel-connect-'));

describe('the protected store', () => {
  test('seals and opens', () => {
    const key = randomBytes(32);
    expect(open(key, seal(key, data))).toEqual(data);
  });

  test('a changed byte or another key is refused', () => {
    const key = randomBytes(32);
    const sealed = seal(key, data);
    const tampered = Buffer.from(sealed);
    tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 1, tampered.length - 1);
    expect(() => open(key, tampered)).toThrow();
    expect(() => open(randomBytes(32), sealed)).toThrow();
  });

  test('the keyed file holds no token in the clear and only the user can read it', async () => {
    const path = join(folder(), 'connect.sealed');
    const vault = keyedFileVault(path, randomBytes(32));
    await vault.write(data);
    expect(readFileSync(path).includes(Buffer.from('refresh-1'))).toBe(false);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await vault.read()).toEqual(data);
    expect(vault.storage).toBe('keystore');
  });

  test('a store the key cannot open starts signed out', async () => {
    const path = join(folder(), 'connect.sealed');
    await keyedFileVault(path, randomBytes(32)).write(data);
    expect(await keyedFileVault(path, randomBytes(32)).read()).toEqual(EMPTY_VAULT);
  });

  test('without a keystore, a file only the user can read, and it says so', async () => {
    const path = join(folder(), 'connect.json');
    const vault = plainFileVault(path);
    expect(await vault.read()).toEqual(EMPTY_VAULT);
    await vault.write(data);
    expect(await vault.read()).toEqual(data);
    expect(vault.storage).toBe('file');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(path, '{broken');
    expect(await vault.read()).toEqual(EMPTY_VAULT);
  });
});

describe('the identity provider', () => {
  test('PKCE: the challenge is the verifier’s SHA-256, base64url', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

  test('reads who signed in from the ID token', () => {
    const tokens = tokensFrom({ access_token: jwt({ sub: 'a' }), refresh_token: 'r', id_token: jwt({ sub: 'a', email: 'p@example.com' }), expires_in: 300 }, 1000);
    expect(tokens).toMatchObject({ subject: 'a', email: 'p@example.com', refreshToken: 'r', accessExpiresAt: 301_000 });
    expect(jwtClaims('not a jwt')).toEqual({});
  });

  test('a refresh that sends no new refresh token keeps the old one', () => {
    const previous = tokensFor(1, 0);
    expect(tokensFrom({ access_token: jwt({ sub: 'sub-1' }), expires_in: 60 }, 0, previous)).toMatchObject({ refreshToken: 'refresh-1', email: 'person@example.com' });
  });

  function provider(answers: Array<{ status: number; body: unknown }>) {
    const asked: Array<{ url: string; body: string | null }> = [];
    const discovery = { authorization_endpoint: 'https://id.example.test/auth', token_endpoint: 'https://id.example.test/token' };
    const fetcher = (async (url: string, init?: RequestInit) => {
      asked.push({ url, body: typeof init?.body === 'string' ? init.body : null });
      if (url.endsWith('/.well-known/openid-configuration')) return new Response(JSON.stringify(discovery));
      const next = answers.shift() ?? { status: 500, body: {} };
      return new Response(JSON.stringify(next.body), { status: next.status });
    }) as typeof fetch;
    return { idp: new OidcProvider(async () => 'https://id.example.test/realms/kestrel', 'kestrel-desktop', fetcher), asked };
  }

  test('asks for a code with PKCE and the loopback redirect', async () => {
    const { idp, asked } = provider([]);
    const request = await idp.authorize('http://127.0.0.1:5000/callback');
    const url = new URL(request.url);
    expect(asked[0]?.url).toBe('https://id.example.test/realms/kestrel/.well-known/openid-configuration');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: 'kestrel-desktop', response_type: 'code', redirect_uri: 'http://127.0.0.1:5000/callback', code_challenge_method: 'S256', state: request.state, scope: 'openid email offline_access' });
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(request.verifier).digest('base64url'));
  });

  test('exchanges the code with the verifier', async () => {
    const { idp, asked } = provider([{ status: 200, body: { access_token: jwt({ sub: 's', email: 'e@example.com' }), refresh_token: 'r', expires_in: 300 } }]);
    const request = await idp.authorize('http://127.0.0.1:5000/callback');
    expect((await idp.exchange('the-code', request)).email).toBe('e@example.com');
    const sent = new URLSearchParams(asked[asked.length - 1]?.body ?? '');
    expect(Object.fromEntries(sent)).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', code_verifier: request.verifier, client_id: 'kestrel-desktop' });
  });

  test('a refused refresh ends the sign-in; another failure does not', async () => {
    const { idp } = provider([
      { status: 400, body: { error: 'invalid_grant', error_description: 'Token is not active' } },
      { status: 503, body: {} },
    ]);
    await expect(idp.refresh(tokensFor(1, 0))).rejects.toBeInstanceOf(SignInEnded);
    const other = await idp.refresh(tokensFor(1, 0)).catch((e: unknown) => e);
    expect(other).toBeInstanceOf(Error);
    expect(other).not.toBeInstanceOf(SignInEnded);
  });
});

describe('the loopback redirect', () => {
  test('takes only the callback with its state, once, then closes', async () => {
    const callback = await listenForCallback(() => 'the-state', 5_000);
    expect(callback.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect((await fetch(`${callback.redirectUri}?code=c&state=wrong`)).status).toBe(404);
    expect((await fetch(callback.redirectUri.replace('/callback', '/other?code=c&state=the-state'))).status).toBe(404);
    const page = await fetch(`${callback.redirectUri}?code=c&state=the-state`);
    expect(await page.text()).toContain('Signed in to Kestrel Connect');
    expect(await callback.result).toEqual({ code: 'c' });
    await expect(fetch(`${callback.redirectUri}?code=c&state=the-state`)).rejects.toThrow();
  });

  test('a refusal from the sign-in page comes back as the reason', async () => {
    const callback = await listenForCallback(() => 's', 5_000);
    await fetch(`${callback.redirectUri}?error=access_denied&error_description=${encodeURIComponent('<b>no</b>')}&state=s`).then((r) => r.text());
    expect(await callback.result).toEqual({ error: '<b>no</b>' });
  });
});

describe('start', () => {
  test('names the computer without its local domain', () => {
    expect(computerName('Studio-Mac.local')).toBe('Studio-Mac');
    expect(computerName('')).toBe('This computer');
  });

  test('the public service unless one is named', () => {
    expect(serviceUrl({})).toBe('https://connect.kestrelapp.ai');
    expect(serviceUrl({ KESTREL_CONNECT_URL: 'https://connect.example.test/' })).toBe('https://connect.example.test');
  });
});
