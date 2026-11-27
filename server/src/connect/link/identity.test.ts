// The real OIDC provider's device authorization grant (RFC 8628) against a stub fetch: the PKCE challenge goes with
// the device request, the verifier with each poll, and every answer the realm gives is worded. No network.
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { CONNECT_NODE_CLIENT } from '../../shared/connect.ts';
import { DEVICE_CODE_EXPIRED, DEVICE_SIGN_IN_DENIED, DeviceGrantEnded, OidcProvider, type DeviceAuthorization } from './identity.ts';

const ISSUER = 'https://id.example.test/realms/kestrel';
const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

interface Call {
  url: string;
  form: URLSearchParams;
}

/** A realm that answers discovery, the device endpoint and the token endpoint from a script; records each form posted. */
function realm(tokenAnswers: { status: number; body: object }[], discovery: object = {}) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/.well-known/openid-configuration')) return json(200, { authorization_endpoint: `${ISSUER}/auth`, token_endpoint: `${ISSUER}/token`, device_authorization_endpoint: `${ISSUER}/device`, ...discovery });
    const form = new URLSearchParams(String(init?.body ?? ''));
    calls.push({ url, form });
    if (url.endsWith('/device')) return json(200, { device_code: 'the-device-code', user_code: 'WDJB-MJHT', verification_uri: `${ISSUER}/device`, verification_uri_complete: `${ISSUER}/device?user_code=WDJB-MJHT`, expires_in: 600, interval: 5 });
    const next = tokenAnswers.shift() ?? { status: 400, body: { error: 'authorization_pending' } };
    return json(next.status, next.body);
  }) as typeof fetch;
  return { provider: new OidcProvider(async () => ISSUER, CONNECT_NODE_CLIENT, fetcher), calls };
}

describe('the device authorization grant', () => {
  test('asks the device endpoint as kestrel-node with an S256 challenge, and says where to sign in', async () => {
    // Arrange
    const { provider, calls } = realm([]);
    // Act
    const request = await provider.deviceAuthorize();
    // Assert
    const [device] = calls;
    expect(device?.url).toBe(`${ISSUER}/device`);
    expect(device?.form.get('client_id')).toBe('kestrel-node');
    expect(device?.form.get('scope')).toBe('openid email offline_access');
    expect(device?.form.get('code_challenge_method')).toBe('S256');
    expect(device?.form.get('code_challenge')).toBe(createHash('sha256').update(request.verifier).digest('base64url'));
    expect(device?.form.has('code_verifier')).toBe(false);
    expect(request).toMatchObject({ verificationUri: `${ISSUER}/device`, userCode: 'WDJB-MJHT', verificationUriComplete: `${ISSUER}/device?user_code=WDJB-MJHT`, intervalMs: 5_000, deviceCode: 'the-device-code' });
  });

  test('polls with the device code and the verifier, and reads the tokens', async () => {
    const access = jwt({ sub: 'sub-1', email: 'person@example.com', exp: Math.floor(Date.now() / 1000) + 300 });
    const { provider, calls } = realm([{ status: 200, body: { access_token: access, refresh_token: 'refresh', expires_in: 300 } }]);
    const request = await provider.deviceAuthorize();
    const answer = await provider.devicePoll(request);
    const poll = calls.at(-1)!;
    expect(poll.url).toBe(`${ISSUER}/token`);
    expect(poll.form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(poll.form.get('device_code')).toBe('the-device-code');
    expect(poll.form.get('code_verifier')).toBe(request.verifier);
    expect(poll.form.get('client_id')).toBe('kestrel-node');
    expect(answer).toMatchObject({ state: 'signed-in', tokens: { subject: 'sub-1', email: 'person@example.com', refreshToken: 'refresh' } });
  });

  test('authorization_pending is a wait and slow_down asks to wait longer', async () => {
    const { provider } = realm([
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 400, body: { error: 'slow_down' } },
    ]);
    const request = await provider.deviceAuthorize();
    expect(await provider.devicePoll(request)).toEqual({ state: 'pending' });
    expect(await provider.devicePoll(request)).toEqual({ state: 'slow-down' });
  });

  test('an expired code and a refused sign-in end the grant, each in plain words', async () => {
    const { provider } = realm([
      { status: 400, body: { error: 'expired_token' } },
      { status: 400, body: { error: 'access_denied' } },
    ]);
    const request = await provider.deviceAuthorize();
    await expect(provider.devicePoll(request)).rejects.toThrow(new DeviceGrantEnded(DEVICE_CODE_EXPIRED));
    await expect(provider.devicePoll(request)).rejects.toThrow(new DeviceGrantEnded(DEVICE_SIGN_IN_DENIED));
  });

  test('any other refusal carries the realm’s description', async () => {
    const { provider } = realm([{ status: 400, body: { error: 'invalid_client', error_description: 'Invalid client credentials' } }]);
    const request: DeviceAuthorization = await provider.deviceAuthorize();
    await expect(provider.devicePoll(request)).rejects.toThrow('Sign-in was refused: Invalid client credentials.');
  });

  test('a realm with no device endpoint says it cannot sign in with a code', async () => {
    const { provider } = realm([], { device_authorization_endpoint: undefined });
    await expect(provider.deviceAuthorize()).rejects.toThrow('does not offer signing in with a code');
  });
});
