#!/usr/bin/env node
// Live check against the real Eight Sleep account. Reads EIGHT_SLEEP_EMAIL / EIGHT_SLEEP_PASSWORD.
// Usage: node scripts/smoke.mjs [--write] [--side left|right] [--level -20]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EightSleepClient } from '../dist/eightSleepClient.js';
import { TokenStore } from '../dist/tokenStore.js';
import { isHouseholdAway, resolveSideAssignments, sideState } from '../dist/sides.js';

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const write = args.includes('--write');
const wantSide = flag('--side', 'left');
const level = Number(flag('--level', '-20'));

const email = process.env.EIGHT_SLEEP_EMAIL;
const password = process.env.EIGHT_SLEEP_PASSWORD;
if (!email || !password) {
  console.error('Set EIGHT_SLEEP_EMAIL and EIGHT_SLEEP_PASSWORD');
  process.exit(2);
}

const redact = id => (id ? `${id.slice(0, 4)}…` : '(none)');
const store = new TokenStore(process.env.SMOKE_TOKEN_DIR ?? join(mkdtempSync(join(tmpdir(), 'hb8s-smoke-')), 'store'));
const client = new EightSleepClient({ email, password, store, log: { debug: m => console.log('  debug:', m), warn: m => console.warn('  warn:', m) } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function snapshot(label) {
  const d = await client.device(deviceId);
  const assignments = resolveSideAssignments(d);
  console.log(`\n== ${label} ==`);
  console.log(`model=${d.modelString} fw=${d.firmwareVersion} online=${d.online}`);
  for (const a of assignments) {
    const s = sideState(d, a.prefix);
    console.log(`${a.side.padEnd(5)} user=${redact(a.userId)} on=${s.on} target=${s.targetLevel} current=${s.currentLevel} nowHeating=${s.nowHeating}`);
  }
  console.log(`away=${isHouseholdAway(d, assignments.map(a => a.userId))} awaySides=${JSON.stringify(Object.keys(d.awaySides ?? {}))}`);
  return { d, assignments };
}

const { userId: myUserId, deviceId } = await client.me();
console.log(`me=${redact(myUserId)} device=${redact(deviceId)}`);
const before = await snapshot('before');

if (!write) {
  console.log('\nRead-only run complete. Add --write to exercise setLevel/setPower.');
  process.exit(0);
}

const target = before.assignments.find(a => a.side === wantSide) ?? before.assignments[0];
const prior = sideState(before.d, target.prefix);
console.log(`\nWriting level ${level} to ${target.side} (user ${redact(target.userId)}${target.userId === myUserId ? ', me' : ', partner'})`);
await client.setLevel(target.userId, level);
await sleep(5000);
const after = await snapshot('after write');
const got = sideState(after.d, target.prefix);
console.log(got.targetLevel === level && got.on ? '\nWRITE OK' : `\nWRITE MISMATCH: expected on target=${level}, got on=${got.on} target=${got.targetLevel}`);

console.log('\nRestoring prior state…');
if (!prior.on) {
  await client.setPower(target.userId, false);
} else {
  await client.setLevel(target.userId, prior.targetLevel);
}
await sleep(5000);
const restored = await snapshot('after restore');
const r = sideState(restored.d, target.prefix);
console.log(r.on === prior.on && (!prior.on || r.targetLevel === prior.targetLevel) ? '\nRESTORE OK' : '\nRESTORE MISMATCH (fix by hand in the Eight Sleep app)');
