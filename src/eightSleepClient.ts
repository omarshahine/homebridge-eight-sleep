import { clampLevel } from './mapping';
import { TokenStore, tokenIdentity } from './tokenStore';
import { AwayModeResponse, DeviceResponse, DeviceResult, MeResponse, TokenResponse, UserResponse } from './types';

// Verbatim from steipete/eightctl. These identify the Eight Sleep Android app, not a user.
export const AUTH_URL = 'https://auth-api.8slp.net/v1/tokens';
export const CLIENT_API = 'https://client-api.8slp.net/v1';
export const APP_API = 'https://app-api.8slp.net/v1';
export const CLIENT_ID = '0894c7f33bb94800a03f1f4df13a4f38';
export const CLIENT_SECRET = 'f0954a3ed5763ba3d06834c73731a32f15f168f47d4f164751275def86db0c76';
export const USER_AGENT = 'okhttp/4.9.3';

const DEFAULT_RETRY_AFTER_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_EXPIRES_IN_S = 3600;
const EXPIRY_SKEW_S = 60;

/** Strips the user id segment from a URL before it lands in a log-visible error message. */
const redactUrl = (url: string): string => url.replace(/\/users\/[^/]+/, '/users/…');

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`Eight Sleep API ${method} ${redactUrl(url)} failed: HTTP ${status}${body ? ` ${body.slice(0, 200)}` : ''}`);
    this.name = 'ApiError';
  }
}

export class RateLimitedError extends ApiError {
  constructor(method: string, url: string, public readonly retryAfterMs: number) {
    super(429, method, url, '');
    this.name = 'RateLimitedError';
    this.message = `Eight Sleep API rate limited (${method} ${redactUrl(url)}); retry in ${Math.round(retryAfterMs / 1000)}s`;
  }
}

export interface ClientLogger {
  debug(msg: string): void;
  warn(msg: string): void;
}

export interface ClientOptions {
  email: string;
  password: string;
  store?: TokenStore;
  fetch?: typeof fetch;
  now?: () => number;
  log?: ClientLogger;
  timeoutMs?: number;
}

const silent: ClientLogger = { debug: () => undefined, warn: () => undefined };

export class EightSleepClient {
  /** Epoch ms. While now < blockedUntil, every call throws RateLimitedError without touching the network. */
  public blockedUntil = 0;
  public userId?: string;

  private readonly email: string;
  private readonly password: string;
  private readonly store?: TokenStore;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: ClientLogger;
  private readonly timeoutMs: number;
  private readonly identity: string;
  private token?: string;
  private tokenExpiresAt = 0;
  private authInFlight?: Promise<void>;

  constructor(opts: ClientOptions) {
    this.email = opts.email;
    this.password = opts.password;
    this.store = opts.store;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? silent;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.identity = tokenIdentity(this.email, CLIENT_ID);

    const cached = this.store?.load(this.identity);
    if (cached && cached.expiresAt > this.now()) {
      this.token = cached.token;
      this.tokenExpiresAt = cached.expiresAt;
      this.userId = cached.userId;
      this.log.debug('Loaded cached Eight Sleep token');
    }
  }

  // ---- public API ---------------------------------------------------------

  async me(): Promise<{ userId: string; deviceId: string }> {
    const res = await this.request<MeResponse>('GET', `${CLIENT_API}/users/me`);
    const userId = res.user?.userId;
    const deviceId = res.user?.currentDevice?.id || res.user?.devices?.[0];
    if (!userId) {
      throw new Error('Eight Sleep /users/me returned no userId');
    }
    if (!deviceId) {
      throw new Error('Eight Sleep account has no device');
    }
    this.userId = userId;
    return { userId, deviceId };
  }

  async device(deviceId: string): Promise<DeviceResult> {
    const res = await this.request<DeviceResponse>('GET', `${CLIENT_API}/devices/${encodeURIComponent(deviceId)}`);
    return res.result ?? {};
  }

  async user(userId: string): Promise<{ userId: string; firstName?: string }> {
    const res = await this.request<UserResponse>('GET', `${CLIENT_API}/users/${encodeURIComponent(userId)}`);
    return { userId: res.user?.userId ?? userId, firstName: res.user?.firstName || undefined };
  }

  async setPower(userId: string, on: boolean): Promise<void> {
    await this.request('PUT', this.temperatureUrl(userId), { currentState: { type: on ? 'smart' : 'off' } });
  }

  /** Sets the target level (-100..100). Like eightctl, this also switches the side to "smart" (on). */
  async setLevel(userId: string, level: number): Promise<void> {
    const url = this.temperatureUrl(userId);
    await this.request('PUT', url, { currentState: { type: 'smart' } });
    await this.request('PUT', url, { currentLevel: clampLevel(level) });
  }

  async setAway(userId: string, away: boolean): Promise<void> {
    const ts = new Date(this.now() - 24 * 60 * 60 * 1000).toISOString();
    const payload = away ? { awayPeriod: { start: ts } } : { awayPeriod: { end: ts } };
    await this.request('PUT', `${APP_API}/users/${encodeURIComponent(userId)}/away-mode`, payload);
  }

  async getAway(userId: string): Promise<boolean> {
    const res = await this.request<AwayModeResponse>('GET', `${APP_API}/users/${encodeURIComponent(userId)}/away-mode`);
    if (typeof res.isAway !== 'boolean') {
      throw new Error('Eight Sleep away-mode response returned no isAway state');
    }
    return res.isAway;
  }

  // ---- internals ----------------------------------------------------------

  private temperatureUrl(userId: string): string {
    return `${APP_API}/users/${encodeURIComponent(userId)}/temperature`;
  }

  private assertNotBlocked(method: string, url: string): void {
    const remaining = this.blockedUntil - this.now();
    if (remaining > 0) {
      throw new RateLimitedError(method, url, remaining);
    }
  }

  private handle429(method: string, url: string, res: Response): never {
    const header = Number(res.headers.get('retry-after'));
    const retryAfterMs = Number.isFinite(header) && header > 0 ? header * 1000 : DEFAULT_RETRY_AFTER_MS;
    this.blockedUntil = this.now() + retryAfterMs;
    throw new RateLimitedError(method, url, retryAfterMs);
  }

  private async authenticate(): Promise<void> {
    this.assertNotBlocked('POST', AUTH_URL);
    const form = new URLSearchParams({
      grant_type: 'password',
      username: this.email,
      password: this.password,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    const res = await this.fetchImpl(AUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: form.toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 429) {
      this.handle429('POST', AUTH_URL, res);
    }
    if (!res.ok) {
      // Never include the request body here: it contains the password.
      throw new ApiError(res.status, 'POST', AUTH_URL, res.status === 401 ? 'check email/password' : '');
    }
    const rawBody = await res.text();
    let body: TokenResponse;
    try {
      body = JSON.parse(rawBody) as TokenResponse;
    } catch {
      // Never include the response text here: a captive-portal/proxy body could echo the request.
      throw new ApiError(res.status, 'POST', AUTH_URL, 'invalid JSON in token response');
    }
    if (!body.access_token) {
      throw new Error('Eight Sleep auth returned no access_token');
    }
    const expiresIn = body.expires_in && body.expires_in > 0 ? body.expires_in : DEFAULT_EXPIRES_IN_S;
    this.token = body.access_token;
    this.tokenExpiresAt = this.now() + Math.max(expiresIn - EXPIRY_SKEW_S, 60) * 1000;
    if (body.userId) {
      this.userId = body.userId;
    }
    try {
      this.store?.save({ identity: this.identity, token: this.token, expiresAt: this.tokenExpiresAt, userId: this.userId });
    } catch (err) {
      this.log.debug(`Could not cache token: ${String(err)}`);
    }
    this.log.debug('Authenticated with Eight Sleep');
  }

  private async ensureToken(): Promise<string> {
    if (!this.token || this.tokenExpiresAt <= this.now()) {
      if (!this.authInFlight) {
        this.authInFlight = this.authenticate().finally(() => {
          this.authInFlight = undefined;
        });
      }
      await this.authInFlight;
    }
    return this.token!;
  }

  private clearToken(): void {
    this.token = undefined;
    this.tokenExpiresAt = 0;
    try {
      this.store?.clear();
    } catch (err) {
      this.log.debug(`Could not clear cached token: ${String(err)}`);
    }
  }

  private async request<T = unknown>(method: 'GET' | 'PUT', url: string, body?: unknown, retried = false): Promise<T> {
    this.assertNotBlocked(method, url);
    const token = await this.ensureToken();
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'Accept': 'application/json',
        'Connection': 'keep-alive',
        'User-Agent': USER_AGENT,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (res.status === 429) {
      this.handle429(method, url, res);
    }
    if (res.status === 401) {
      if (retried) {
        throw new ApiError(401, method, url, 'unauthorized after re-authentication');
      }
      this.log.debug('Eight Sleep token rejected; re-authenticating');
      this.clearToken();
      return this.request<T>(method, url, body, true);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(res.status, method, url, text.replace(/\s+/g, ' ').trim());
    }
    const text = await res.text().catch(() => '');
    if (!text) {
      return {} as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(res.status, method, url, `invalid JSON: ${text.replace(/\s+/g, ' ').trim().slice(0, 80)}`);
    }
  }
}
