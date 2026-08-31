import { describe, expect, it } from 'vitest';
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings';
import pkg from '../package.json';

describe('settings', () => {
  it('plugin name matches package.json', () => {
    expect(PLUGIN_NAME).toBe(pkg.name);
  });

  it('platform alias is EightSleep', () => {
    expect(PLATFORM_NAME).toBe('EightSleep');
  });
});
