import { mkdtempSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TokenStore, tokenIdentity } from '../src/tokenStore';

function freshDir() {
  return join(mkdtempSync(join(tmpdir(), 'hb8s-')), 'homebridge-eight-sleep');
}

describe('tokenIdentity', () => {
  it('is stable, case-insensitive on email, and not the raw email', () => {
    const a = tokenIdentity('Me@Example.com', 'cid');
    expect(a).toBe(tokenIdentity('me@example.com', 'cid'));
    expect(a).not.toBe(tokenIdentity('me@example.com', 'other'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('TokenStore', () => {
  it('round-trips and sets restrictive permissions', () => {
    const dir = freshDir();
    const store = new TokenStore(dir);
    const t = { identity: 'id1', token: 'tok', expiresAt: 123, userId: 'u' };
    store.save(t);
    expect(store.load('id1')).toEqual(t);
    expect(statSync(join(dir, 'token.json')).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('returns undefined for missing file, identity mismatch, or garbage', () => {
    const dir = freshDir();
    const store = new TokenStore(dir);
    expect(store.load('id1')).toBeUndefined();
    store.save({ identity: 'other', token: 't', expiresAt: 1 });
    expect(store.load('id1')).toBeUndefined();
    writeFileSync(join(dir, 'token.json'), '{not json');
    expect(store.load('id1')).toBeUndefined();
  });

  it('clear removes the file and is idempotent', () => {
    const dir = freshDir();
    const store = new TokenStore(dir);
    store.save({ identity: 'id1', token: 't', expiresAt: 1 });
    store.clear();
    expect(existsSync(join(dir, 'token.json'))).toBe(false);
    expect(() => store.clear()).not.toThrow();
  });

  it('never writes the token in plain view of the identity source', () => {
    const dir = freshDir();
    const store = new TokenStore(dir);
    store.save({ identity: tokenIdentity('me@example.com', 'cid'), token: 't', expiresAt: 1 });
    expect(readFileSync(join(dir, 'token.json'), 'utf8')).not.toContain('me@example.com');
  });
});
