import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { APP_API, AUTH_URL, CLIENT_API, EightSleepClient, RateLimitedError, ApiError } from '../src/eightSleepClient';
import { TokenStore, tokenIdentity } from '../src/tokenStore';

type Call = { url: string; init: RequestInit };

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** Queue of responses; records every call. */
function fakeFetch(responses: Response[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses.shift();
    if (!r) {
      throw new Error(`unexpected fetch ${String(url)}`);
    }
    return r;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function mkStore() {
  return new TokenStore(join(mkdtempSync(join(tmpdir(), 'hb8s-')), 'x'));
}

const token = (t = 'tok1') => json({ access_token: t, expires_in: 3600, userId: 'U1' });

describe('authentication', () => {
  it('sends a password grant form and reuses the token for later calls', async () => {
    const f = fakeFetch([token(), json({ user: { userId: 'U1', currentDevice: { id: 'D1' } } })]);
    const c = new EightSleepClient({ email: 'a@b.c', password: 'pw', fetch: f.fn, store: mkStore() });
    const me = await c.me();
    expect(me).toEqual({ userId: 'U1', deviceId: 'D1' });

    expect(f.calls[0].url).toBe(AUTH_URL);
    expect(f.calls[0].init.method).toBe('POST');
    const body = new URLSearchParams(String(f.calls[0].init.body));
    expect(body.get('grant_type')).toBe('password');
    expect(body.get('username')).toBe('a@b.c');
    expect(body.get('password')).toBe('pw');
    expect(body.get('client_id')).toBeTruthy();
    expect(body.get('client_secret')).toBeTruthy();

    const h = new Headers(f.calls[1].init.headers);
    expect(h.get('authorization')).toBe('Bearer tok1');
    expect(h.get('user-agent')).toBe('okhttp/4.9.3');
    expect(f.calls[1].url).toBe(`${CLIENT_API}/users/me`);
    expect(c.userId).toBe('U1');
  });

  it('loads a cached, unexpired token instead of logging in', async () => {
    const store = mkStore();
    store.save({ identity: tokenIdentity('a@b.c', '0894c7f33bb94800a03f1f4df13a4f38'), token: 'cached', expiresAt: 10_000, userId: 'U1' });
    const f = fakeFetch([json({ user: { userId: 'U1', devices: ['D9'] } })]);
    const c = new EightSleepClient({ email: 'a@b.c', password: 'pw', fetch: f.fn, store, now: () => 1000 });
    const me = await c.me();
    expect(me.deviceId).toBe('D9');
    expect(f.calls).toHaveLength(1);
    expect(new Headers(f.calls[0].init.headers).get('authorization')).toBe('Bearer cached');
  });

  it('ignores an expired cached token', async () => {
    const store = mkStore();
    store.save({ identity: tokenIdentity('a@b.c', '0894c7f33bb94800a03f1f4df13a4f38'), token: 'old', expiresAt: 500 });
    const f = fakeFetch([token('new'), json({ user: { userId: 'U1', currentDevice: { id: 'D1' } } })]);
    const c = new EightSleepClient({ email: 'a@b.c', password: 'pw', fetch: f.fn, store, now: () => 1000 });
    await c.me();
    expect(f.calls[0].url).toBe(AUTH_URL);
    expect(store.load(tokenIdentity('a@b.c', '0894c7f33bb94800a03f1f4df13a4f38'))?.token).toBe('new');
  });

  it('persists the token with expiry = now + expires_in - 60s', async () => {
    const store = mkStore();
    const f = fakeFetch([
      json({ access_token: 't', expires_in: 200, userId: 'U1' }),
      json({ user: { userId: 'U1', currentDevice: { id: 'D1' } } }),
    ]);
    const c = new EightSleepClient({ email: 'a@b.c', password: 'pw', fetch: f.fn, store, now: () => 1_000_000 });
    await c.me();
    expect(store.load(tokenIdentity('a@b.c', '0894c7f33bb94800a03f1f4df13a4f38'))?.expiresAt).toBe(1_000_000 + 140_000);
  });

  it('auth failure surfaces as ApiError without the password in the message', async () => {
    const f = fakeFetch([new Response('nope', { status: 401 })]);
    const c = new EightSleepClient({ email: 'a@b.c', password: 'secretpw', fetch: f.fn, store: mkStore() });
    const err = await c.me().catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(String(err)).not.toContain('secretpw');
    expect((err as ApiError).message).not.toContain('secretpw');
  });

  it('never records an already-expired token when expires_in is tiny', async () => {
    const store = mkStore();
    const f = fakeFetch([
      json({ access_token: 't', expires_in: 30, userId: 'U1' }),
      json({ user: { userId: 'U1', currentDevice: { id: 'D1' } } }),
      json({ result: {} }),
    ]);
    const c = new EightSleepClient({ email: 'a@b.c', password: 'pw', fetch: f.fn, store, now: () => 1_000_000 });
    await c.me();
    await c.device('D1');
    expect(f.calls.filter(x => x.url === AUTH_URL)).toHaveLength(1);
    expect(store.load(tokenIdentity('a@b.c', '0894c7f33bb94800a03f1f4df13a4f38'))?.expiresAt).toBe(1_000_000 + 60_000);
  });

  it('deduplicates concurrent authentication into a single token request', async () => {
    const f = fakeFetch([token(), json({ result: { online: true } }), json({ result: { online: true } })]);
    const c = new EightSleepClient({ email: 'a@b.c', password: 'pw', fetch: f.fn, store: mkStore() });
    const [a, b] = await Promise.all([c.device('D1'), c.device('D1')]);
    expect(a).toEqual({ online: true });
    expect(b).toEqual({ online: true });
    expect(f.calls.filter(x => x.url === AUTH_URL)).toHaveLength(1);
    expect(f.calls).toHaveLength(3);
  });
});

describe('401 handling', () => {
  it('re-authenticates once and retries, clearing the stale cached token', async () => {
    const store = mkStore();
    store.save({ identity: tokenIdentity('a@b.c', '0894c7f33bb94800a03f1f4df13a4f38'), token: 'stale', expiresAt: 10_000 });
    const f = fakeFetch([
      new Response('', { status: 401 }),
      token('fresh'),
      json({ user: { userId: 'U1', currentDevice: { id: 'D1' } } }),
    ]);
    const c = new EightSleepClient({ email: 'a@b.c', password: 'pw', fetch: f.fn, store, now: () => 1000 });
    await c.me();
    expect(f.calls.map(x => x.url)).toEqual([`${CLIENT_API}/users/me`, AUTH_URL, `${CLIENT_API}/users/me`]);
    expect(new Headers(f.calls[2].init.headers).get('authorization')).toBe('Bearer fresh');
  });

  it('a second 401 is an error, not a loop', async () => {
    const f = fakeFetch([token(), new Response('', { status: 401 }), token('t2'), new Response('', { status: 401 })]);
    const c = new EightSleepClient({ email: 'a@b.c', password: 'pw', fetch: f.fn, store: mkStore() });
    await expect(c.me()).rejects.toMatchObject({ status: 401 });
    expect(f.calls).toHaveLength(4);
  });
});

describe('429 handling', () => {
  it('RateLimitedError message does not leak the user id from the URL', async () => {
    const f = fakeFetch([token(), new Response('', { status: 429, headers: { 'retry-after': '5' } })]);
    const c = new EightSleepClient({ email: 'a@b.c', password: 'pw', fetch: f.fn, store: mkStore(), now: () => 0 });
    const err = await c.setPower('SECRETUSER', true).catch(e => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.message).not.toContain('SECRETUSER');
    expect(err.message).toContain('/users/…/temperature');
    // A blocked call that never reaches the network is redacted too.
    const err2 = await c.setPower('SECRETUSER', true).catch(e => e);
    expect(err2).toBeInstanceOf(RateLimitedError);
    expect(err2.message).not.toContain('SECRETUSER');
  });

  it('honors Retry-After, sets blockedUntil, and short-circuits until then', async () => {
    let now = 1000;
    const f = fakeFetch([token(), new Response('', { status: 429, headers: { 'retry-after': '45' } })]);
    const c = new EightSleepClient({ email: 'a@b.c', password: 'pw', fetch: f.fn, store: mkStore(), now: () => now });
    const err = await c.me().catch(e => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterMs).toBe(45_000);
    expect(c.blockedUntil).toBe(1000 + 45_000);

    // No network call while blocked.
    await expect(c.me()).rejects.toBeInstanceOf(RateLimitedError);
    expect(f.calls).toHaveLength(2);

    now = 1000 + 45_001;
    f.calls.length = 0;
    await expect(c.me()).rejects.toThrow(/unexpected fetch/); // proves it tried the network again
  });

  it('defaults Retry-After to 30s when absent', async () => {
    const f = fakeFetch([new Response('', { status: 429 })]);
    const c = new EightSleepClient({ email: 'a@b.c', password: 'pw', fetch: f.fn, store: mkStore(), now: () => 0 });
    await expect(c.me()).rejects.toBeInstanceOf(RateLimitedError);
    expect(c.blockedUntil).toBe(30_000);
  });
});

describe('commands', () => {
  async function authed(responses: Response[]) {
    const f = fakeFetch([token(), ...responses]);
    const c = new EightSleepClient({ email: 'a@b.c', password: 'pw', fetch: f.fn, store: mkStore() });
    return { c, f };
  }

  it('device() unwraps result', async () => {
    const { c, f } = await authed([json({ result: { online: true, leftUserId: 'L' } })]);
    expect(await c.device('D1')).toEqual({ online: true, leftUserId: 'L' });
    expect(f.calls[1].url).toBe(`${CLIENT_API}/devices/D1`);
  });

  it('user() returns id and first name', async () => {
    const { c, f } = await authed([json({ user: { userId: 'L', firstName: 'Omar' } })]);
    expect(await c.user('L')).toEqual({ userId: 'L', firstName: 'Omar' });
    expect(f.calls[1].url).toBe(`${CLIENT_API}/users/L`);
  });

  it('setPower PUTs currentState smart/off on the app API', async () => {
    const { c, f } = await authed([json({}), json({})]);
    await c.setPower('L', true);
    await c.setPower('L', false);
    expect(f.calls[1].url).toBe(`${APP_API}/users/L/temperature`);
    expect(f.calls[1].init.method).toBe('PUT');
    expect(JSON.parse(String(f.calls[1].init.body))).toEqual({ currentState: { type: 'smart' } });
    expect(JSON.parse(String(f.calls[2].init.body))).toEqual({ currentState: { type: 'off' } });
  });

  it('setLevel forces smart then writes the clamped level', async () => {
    const { c, f } = await authed([json({}), json({})]);
    await c.setLevel('R', -140);
    expect(JSON.parse(String(f.calls[1].init.body))).toEqual({ currentState: { type: 'smart' } });
    expect(JSON.parse(String(f.calls[2].init.body))).toEqual({ currentLevel: -100 });
    expect(f.calls[2].url).toBe(`${APP_API}/users/R/temperature`);
  });

  it('setAway writes a start (away) or end (home) 24h in the past', async () => {
    const t0 = Date.UTC(2026, 0, 2, 12, 0, 0);
    const f = fakeFetch([token(), json({}), json({})]);
    const c = new EightSleepClient({ email: 'a@b.c', password: 'pw', fetch: f.fn, store: mkStore(), now: () => t0 });
    await c.setAway('L', true);
    await c.setAway('L', false);
    expect(f.calls[1].url).toBe(`${APP_API}/users/L/away-mode`);
    expect(f.calls[1].init.method).toBe('PUT');
    expect(JSON.parse(String(f.calls[1].init.body))).toEqual({ awayPeriod: { start: '2026-01-01T12:00:00.000Z' } });
    expect(JSON.parse(String(f.calls[2].init.body))).toEqual({ awayPeriod: { end: '2026-01-01T12:00:00.000Z' } });
  });

  it('getAway reads the authoritative per-user away state', async () => {
    const { c, f } = await authed([json({ isAway: false }), json({ isAway: true })]);
    await expect(c.getAway('L')).resolves.toBe(false);
    await expect(c.getAway('R')).resolves.toBe(true);
    expect(f.calls[1].url).toBe(`${APP_API}/users/L/away-mode`);
    expect(f.calls[1].init.method).toBe('GET');
    expect(f.calls[2].url).toBe(`${APP_API}/users/R/away-mode`);
  });

  it('getAway rejects a response without a boolean isAway state', async () => {
    const { c } = await authed([json({})]);
    await expect(c.getAway('L')).rejects.toThrow(/no isAway state/);
  });

  it('redacts the user id from an ApiError message built from a /users/ URL', async () => {
    const { c } = await authed([new Response('boom', { status: 500 })]);
    const err = await c.setPower('SECRETID', true).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).not.toContain('SECRETID');
  });

  it('non-2xx surfaces as ApiError with status and a body snippet', async () => {
    const { c } = await authed([new Response('<html>boom</html>', { status: 500 })]);
    const err = await c.device('D1').catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(err.message).toContain('500');
  });

  it('non-JSON 2xx body surfaces as ApiError with context', async () => {
    const { c } = await authed([new Response('<html>captive portal</html>', { status: 200 })]);
    const err = await c.device('D1').catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toContain('/devices/D1');
    expect(err.message).toContain('invalid JSON');
  });
});
