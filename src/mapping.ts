import { Mode } from './types';

const MIN_F = 55;
const MAX_F = 110;

/** Round and clamp an Eight Sleep level to -100..100. Non-finite input becomes 0. */
export function clampLevel(n: number): number {
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.max(-100, Math.min(100, Math.round(n)));
}

/** Sign of the level as a HomeKit mode. Level 0 has no sign, so the caller's fallback wins. */
export function modeOf(level: number, fallback: Mode): Mode {
  if (level > 0) {
    return 'heat';
  }
  if (level < 0) {
    return 'cool';
  }
  return fallback;
}

/** Magnitude of the level, 0..100. */
export function intensityOf(level: number): number {
  return Math.abs(clampLevel(level));
}

/** Rebuild a level from mode + intensity. */
export function composeLevel(mode: Mode, intensity: number): number {
  const magnitude = Math.abs(clampLevel(intensity));
  if (magnitude === 0) {
    return 0;
  }
  return mode === 'heat' ? magnitude : -magnitude;
}

/**
 * HAP requires CurrentTemperature on a HeaterCooler. Eight Sleep publishes a
 * 55-110 F surface range for level -100..+100; map linearly and report in C.
 * This is an approximation, not a measured temperature.
 */
export function pseudoCelsius(level: number): number {
  const l = clampLevel(level);
  const f = MIN_F + ((l + 100) / 200) * (MAX_F - MIN_F);
  const c = (f - 32) * 5 / 9;
  return Math.round(c * 10) / 10;
}
