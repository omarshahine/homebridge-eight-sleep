import type { API, Logger, PlatformAccessory } from 'homebridge';
import { describe, expect, it, vi } from 'vitest';
import { AwayAccessory } from '../src/awayAccessory';
import type { EightSleepClient } from '../src/eightSleepClient';

function setup(setAway = vi.fn(async () => undefined)) {
  let setter: ((value: unknown) => Promise<void>) | undefined;
  const on = {
    onGet: vi.fn().mockReturnThis(),
    onSet: vi.fn((fn: (value: unknown) => Promise<void>) => {
      setter = fn;
      return on;
    }),
  };
  const service = {
    setCharacteristic: vi.fn().mockReturnThis(),
    getCharacteristic: vi.fn(() => on),
    updateCharacteristic: vi.fn().mockReturnThis(),
  };
  const info = { setCharacteristic: vi.fn().mockReturnThis() };
  const HapStatusError = class extends Error {};
  const api = {
    hap: {
      Service: { AccessoryInformation: 'AI', Switch: 'SW' },
      Characteristic: { Manufacturer: 'M', Model: 'Mo', SerialNumber: 'S', FirmwareRevision: 'F', Name: 'N', On: 'On' },
      HapStatusError,
      HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
    },
  };
  const accessory = {
    getService: (kind: string) => kind === 'AI' ? info : service,
    addService: vi.fn(() => service),
  };
  const log = { info: vi.fn(), error: vi.fn() };
  const onWritten = vi.fn();
  const away = new AwayAccessory({
    api: api as unknown as API,
    log: log as unknown as Logger,
    accessory: accessory as unknown as PlatformAccessory,
    client: { setAway } as unknown as EightSleepClient,
    userId: 'R',
    displayName: 'Lora Away',
    model: 'Pod',
    firmware: '1',
    serial: 'D-right-away',
    isHealthy: () => true,
    onWritten,
  });
  return { away, service, log, onWritten, setAway, HapStatusError, setter: () => setter! };
}

describe('AwayAccessory writes', () => {
  it('keeps an accepted optimistic value until the confirmation poll', async () => {
    const { away, service, onWritten, setAway, setter } = setup();
    await setter()(true);
    expect(setAway).toHaveBeenCalledWith('R', true);
    expect(away.isAway).toBe(true);
    expect(service.updateCharacteristic).toHaveBeenLastCalledWith('On', true);
    expect(onWritten).toHaveBeenCalledTimes(1);
  });

  it('rolls back and reports a HomeKit error when the API write fails', async () => {
    const failure = vi.fn(async () => {
      throw new Error('rejected');
    });
    const { away, service, log, onWritten, HapStatusError, setter } = setup(failure);
    await expect(setter()(true)).rejects.toBeInstanceOf(HapStatusError);
    expect(away.isAway).toBe(false);
    expect(service.updateCharacteristic.mock.calls).toEqual([['On', true], ['On', false]]);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('failed to set away=true'));
    expect(onWritten).toHaveBeenCalledTimes(1);
  });
});
