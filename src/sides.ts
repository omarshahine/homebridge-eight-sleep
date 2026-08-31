import { DeviceResult, Side, SidePrefix, SideState } from './types';

export interface SideAssignment {
  side: Side;
  prefix: SidePrefix;
  userId: string;
}

/**
 * Port of eightctl's sideAssignmentsFromDevice. In Away mode the top-level
 * leftUserId/rightUserId are blank and the real IDs live in awaySides.
 */
export function resolveSideAssignments(d: DeviceResult): SideAssignment[] {
  const away = d.awaySides ?? {};
  const left = (d.leftUserId || away['leftUserId'] || '').trim();
  const right = (d.rightUserId || away['rightUserId'] || '').trim();

  if (left && right && left === right) {
    return [{ side: 'solo', prefix: 'left', userId: left }];
  }
  if (left && right) {
    return [
      { side: 'left', prefix: 'left', userId: left },
      { side: 'right', prefix: 'right', userId: right },
    ];
  }
  if (left) {
    return [{ side: 'solo', prefix: 'left', userId: left }];
  }
  if (right) {
    return [{ side: 'solo', prefix: 'right', userId: right }];
  }
  return [];
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Pull one side's live state out of the /devices/:id payload. */
export function sideState(d: DeviceResult, prefix: SidePrefix): SideState {
  const targetLevel = num(d[`${prefix}TargetHeatingLevel`]);
  const currentLevel = num(d[`${prefix}HeatingLevel`]);
  const kelvin = d[`${prefix}Kelvin`];
  const on = typeof kelvin?.active === 'boolean' ? kelvin.active : targetLevel !== 0;
  return {
    on,
    targetLevel,
    currentLevel,
    nowHeating: d[`${prefix}NowHeating`] === true,
  };
}

/** Household is "away" only when every discovered user is in awaySides. */
export function isHouseholdAway(d: DeviceResult, userIds: string[]): boolean {
  if (userIds.length === 0) {
    return false;
  }
  const awayIds = new Set(Object.values(d.awaySides ?? {}));
  return userIds.every(id => awayIds.has(id));
}
