import { describe, expect, it } from 'vitest';
import { clampLevel, composeLevel, intensityOf, levelFromCelsius, modeOf, pseudoCelsius } from '../src/mapping';

describe('clampLevel', () => {
  it('clamps to -100..100 and rounds', () => {
    expect(clampLevel(150)).toBe(100);
    expect(clampLevel(-150)).toBe(-100);
    expect(clampLevel(12.6)).toBe(13);
    expect(clampLevel(NaN)).toBe(0);
  });
});

describe('modeOf / intensityOf / composeLevel', () => {
  it('positive levels are heat, negative are cool, zero uses fallback', () => {
    expect(modeOf(30, 'cool')).toBe('heat');
    expect(modeOf(-30, 'heat')).toBe('cool');
    expect(modeOf(0, 'cool')).toBe('cool');
    expect(modeOf(0, 'heat')).toBe('heat');
  });

  it('intensity is the magnitude', () => {
    expect(intensityOf(-45)).toBe(45);
    expect(intensityOf(45)).toBe(45);
    expect(intensityOf(0)).toBe(0);
  });

  it('composeLevel applies the sign and clamps', () => {
    expect(composeLevel('heat', 40)).toBe(40);
    expect(composeLevel('cool', 40)).toBe(-40);
    expect(composeLevel('cool', 0)).toBe(0);
    expect(composeLevel('heat', 250)).toBe(100);
  });

  it('round-trips', () => {
    for (const level of [-100, -35, 0, 20, 100]) {
      const mode = modeOf(level, 'cool');
      expect(composeLevel(mode, intensityOf(level))).toBe(level);
    }
  });
});

describe('pseudoCelsius', () => {
  it('maps the published 55-110 F range linearly', () => {
    expect(pseudoCelsius(-100)).toBeCloseTo(12.8, 1);
    expect(pseudoCelsius(0)).toBeCloseTo(28.1, 1);
    expect(pseudoCelsius(100)).toBeCloseTo(43.3, 1);
  });

  it('rounds to one decimal and clamps input', () => {
    expect(pseudoCelsius(-31)).toBe(23.3);
    expect(pseudoCelsius(999)).toBeCloseTo(43.3, 1);
  });
});

describe('levelFromCelsius', () => {
  it('inverts pseudoCelsius at the endpoints and midpoint', () => {
    expect(levelFromCelsius(12.8)).toBe(-100);
    expect(levelFromCelsius(28.1)).toBe(0);
    expect(levelFromCelsius(43.3)).toBe(100);
  });

  it('maps Home-style targets to levels (77 F -> -20, 95 F -> +45)', () => {
    expect(levelFromCelsius(25)).toBe(-20);
    expect(levelFromCelsius(35)).toBe(45);
  });

  it('clamps out-of-range temperatures', () => {
    expect(levelFromCelsius(0)).toBe(-100);
    expect(levelFromCelsius(60)).toBe(100);
    expect(levelFromCelsius(NaN)).toBe(0);
  });

  it('round-trips through pseudoCelsius within one level', () => {
    for (const level of [-100, -73, -31, -20, 0, 7, 45, 100]) {
      expect(Math.abs(levelFromCelsius(pseudoCelsius(level)) - level)).toBeLessThanOrEqual(1);
    }
  });
});
