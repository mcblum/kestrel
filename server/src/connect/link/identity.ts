// The identity provider Kestrel Connect signs in with: the service's OpenID Connect realm, as the
// public client `kestrel-desktop`, by authorization code with PKCE (RFC 7636) and a loopback
// redirect (RFC 8252). Behind an interface so tests never reach the network (`FakeIdentity` in
// connect-fakes.ts).
import { createHash, randomBytes } from 'node:crypto';
import type { StoredTokens } from './vault.ts';

export interface AuthorizationRequest {
  url: string;
  state: string;
  verifier: string;
  redirectUri: string;
}

export interface IdentityProvider {
  /** Where the browser goes to sign in, with a fresh state and PKCE verifier. */
  authorize(redirectUri: string): Promise<AuthorizationRequest>;
  /** The code the browser came back with, exchanged for tokens. */
  exchange(code: string, request: AuthorizationRequest): Promise<StoredTokens>;
  /** A new access token from the refresh token. Throws `SignInEnded` when the sign-in is over. */
  refresh(tokens: StoredTokens): Promise<StoredTokens>;
  /** Ends the sign-in at the provider; best effort. */
  revoke(tokens: StoredTokens): Promise<void>;
}

/** The provider said the sign-in is over (refresh refused): the person signs in again. */
export class SignInEnded extends Error {}

const base64url = (bytes: Buffer): string => bytes.toString('base64url');

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

/** The claims of a JWT, unverified: only for tokens that came straight from the token endpoint over TLS. */
export function jwtClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) return {};
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof claims === 'object' && claims !== null ? (claims as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
}

interface TokenAnswer {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}

const SCOPES = 'openid email offline_access';
const TIMEOUT_MS = 15_000;

/** The tokens in a token endpoint's answer; `previous` fills what a refresh leaves out. */
export function tokensFrom(answer: TokenAnswer, now: number, previous?: StoredTokens): StoredTokens {
  if (typeof answer.access_token !== 'string') throw new Error('The sign-in service sent no access token.');
  const refreshToken = typeof answer.refresh_token === 'string' ? answer.refresh_token : previous?.refreshToken;
  if (!refreshToken) throw new Error('The sign-in service sent no refresh token.');
  const idToken = typeof answer.id_token === 'string' ? answer.id_token : (previous?.idToken ?? null);
  const access = jwtClaims(answer.access_token);
  const id = idToken ? jwtClaims(idToken) : {};
  const subject = String(id.sub ?? access.sub ?? previous?.subject ?? '');
  const email = String(id.email ?? access.email ?? previous?.email ?? '');
  if (!subject) throw new Error('The sign-in service did not say who signed in.');
  const expiresIn = typeof answer.expires_in === 'number' ? answer.expires_in : typeof access.exp === 'number' ? access.exp - now / 1000 : 300;
  return { accessToken: answer.access_token, refreshToken, idToken, accessExpiresAt: now + expiresIn * 1000, subject, email };
}

export class OidcProvider implements IdentityProvider {
  private discovery: Promise<Discovery> | null = null;

  constructor(
    private readonly issuer: () => Promise<string>,
    private readonly clientId: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async endpoints(): Promise<Discovery> {
    this.discovery ??= (async () => {
      const issuer = (await this.issuer()).replace(/\/$/, '');
      const res = await this.fetcher(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`The sign-in service could not be reached (${res.status}).`);
      const found = (await res.json()) as Partial<Discovery>;
      if (typeof found.authorization_endpoint !== 'string' || typeof found.token_endpoint !== 'string') throw new Error('The sign-in service did not say where to sign in.');
      return found as Discovery;
    })();
    // A failure is not kept: the next attempt asks again.
    this.discovery.catch(() => (this.discovery = null));
    return this.discovery;
  }

  async authorize(redirectUri: string): Promise<AuthorizationRequest> {
    const { authorization_endpoint } = await this.endpoints();
    const { verifier, challenge } = pkcePair();
    const state = base64url(randomBytes(16));
    const url = new URL(authorization_endpoint);
    url.search = new URLSearchParams({ client_id: this.clientId, response_type: 'code', scope: SCOPES, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    return { url: url.toString(), state, verifier, redirectUri };
  }

  private async token(params: Record<string, string>): Promise<{ status: number; answer: TokenAnswer }> {
    const { token_endpoint } = await this.endpoints();
    const res = await this.fetcher(token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.clientId, ...params }).toString(), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const answer = (await res.json().catch(() => ({}))) as TokenAnswer;
    return { status: res.status, answer };
  }

  async exchange(code: string, request: AuthorizationRequest): Promise<StoredTokens> {
    const { status, answer } = await this.token({ grant_type: 'authorization_code', code, redirect_uri: request.redirectUri, code_verifier: request.verifier });
    if (status !== 200) throw new Error(`Sign-in was refused: ${String(answer.error_description ?? answer.error ?? status)}.`);
    return tokensFrom(answer, Date.now());
  }

  async refresh(tokens: StoredTokens): Promise<StoredTokens> {
    const { status, answer } = await this.token({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
    // invalid_grant: the sign-in expired or was ended. Anything else may pass, and is tried again.
    if (status === 400 && answer.error === 'invalid_grant') throw new SignInEnded(String(answer.error_description ?? 'The sign-in has expired.'));
    if (status !== 200) throw new Error(`The sign-in service answered ${status}.`);
    return tokensFrom(answer, Date.now(), tokens);
  }

  async revoke(tokens: StoredTokens): Promise<void> {
    const { revocation_endpoint } = await this.endpoints();
    if (!revocation_endpoint) return;
    await this.fetcher(revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.clientId, token: tokens.refreshToken, token_type_hint: 'refresh_token' }).toString(), signal: AbortSignal.timeout(TIMEOUT_MS) });
  }
}
