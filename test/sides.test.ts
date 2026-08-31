import { describe, expect, it } from 'vitest';
import { isUserAway, resolveSideAssignments, sideState } from '../src/sides';
import { DeviceResult } from '../src/types';

describe('resolveSideAssignments', () => {
  it('two users, normal mode', () => {
    const d: DeviceResult = { leftUserId: 'L', rightUserId: 'R' };
    expect(resolveSideAssignments(d)).toEqual([
      { side: 'left', prefix: 'left', userId: 'L' },
      { side: 'right', prefix: 'right', userId: 'R' },
    ]);
  });

  it('away mode blanks the top-level ids; falls back to awaySides', () => {
    const d: DeviceResult = { leftUserId: '', rightUserId: '', awaySides: { leftUserId: 'L', rightUserId: 'R' } };
    expect(resolveSideAssignments(d)).toEqual([
      { side: 'left', prefix: 'left', userId: 'L' },
      { side: 'right', prefix: 'right', userId: 'R' },
    ]);
  });

  it('one side away, one home', () => {
    const d: DeviceResult = { leftUserId: 'L', rightUserId: '', awaySides: { rightUserId: 'R' } };
    expect(resolveSideAssignments(d)).toEqual([
      { side: 'left', prefix: 'left', userId: 'L' },
      { side: 'right', prefix: 'right', userId: 'R' },
    ]);
  });

  it('same user on both sides is solo (left fields)', () => {
    expect(resolveSideAssignments({ leftUserId: 'U', rightUserId: 'U' })).toEqual([
      { side: 'solo', prefix: 'left', userId: 'U' },
    ]);
  });

  it('only a right user is solo (right fields)', () => {
    expect(resolveSideAssignments({ rightUserId: 'U' })).toEqual([
      { side: 'solo', prefix: 'right', userId: 'U' },
    ]);
  });

  it('no users yields nothing', () => {
    expect(resolveSideAssignments({})).toEqual([]);
  });
});

describe('sideState', () => {
  it('reads Kelvin.active when present', () => {
    const d: DeviceResult = {
      leftHeatingLevel: -31, leftTargetHeatingLevel: -20, leftNowHeating: false,
      leftKelvin: { active: true, currentTargetLevel: -20 },
    };
    expect(sideState(d, 'left')).toEqual({ on: true, targetLevel: -20, currentLevel: -31, nowHeating: false });
  });

  it('falls back to non-zero target when Kelvin is absent', () => {
    expect(sideState({ rightTargetHeatingLevel: 10, rightHeatingLevel: 5 }, 'right'))
      .toEqual({ on: true, targetLevel: 10, currentLevel: 5, nowHeating: false });
    expect(sideState({ rightTargetHeatingLevel: 0 }, 'right').on).toBe(false);
  });

  it('missing numbers become 0', () => {
    expect(sideState({}, 'left')).toEqual({ on: false, targetLevel: 0, currentLevel: 0, nowHeating: false });
  });
});

describe('isUserAway', () => {
  it('true only when that user id is listed in awaySides', () => {
    const d: DeviceResult = { awaySides: { leftUserId: 'L' } };
    expect(isUserAway(d, 'L')).toBe(true);
    expect(isUserAway(d, 'R')).toBe(false);
    expect(isUserAway({}, 'L')).toBe(false);
    expect(isUserAway({ awaySides: { leftUserId: 'L', rightUserId: 'R' } }, 'R')).toBe(true);
    expect(isUserAway(d, '')).toBe(false);
  });
});
