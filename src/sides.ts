import { DeviceResult, Side, SidePrefix, SideState } from './types';

export interface SideAssignment {
  side: Side;
  prefix: SidePrefix;
  userId: string;
}

/**
 * Port of eightctl's sideAssignmentsFromDevice. The top-level IDs can be
 * blank or duplicate the present user while someone is away; awaySides keeps
 * the stable left/right assignment when it contains a distinct pair.
 */
export function resolveSideAssignments(d: DeviceResult): SideAssignment[] {
  const away = d.awaySides ?? {};
  const awayLeft = (away['leftUserId'] || '').trim();
  const awayRight = (away['rightUserId'] || '').trim();
  // With one person away, Eight Sleep can duplicate the present user's ID in
  // both top-level fields. A distinct pair in awaySides is the stable mapping.
  const hasAwayPair = Boolean(awayLeft && awayRight && awayLeft !== awayRight);
  const left = (hasAwayPair ? awayLeft : d.leftUserId || awayLeft || '').trim();
  const right = (hasAwayPair ? awayRight : d.rightUserId || awayRight || '').trim();

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
