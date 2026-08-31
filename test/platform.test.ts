import type { API, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EightSleepPlatform } from '../src/platform';

vi.mock('../src/eightSleepClient', async (orig) => {
  const mod = await orig<typeof import('../src/eightSleepClient')>();
  return { ...mod, EightSleepClient: vi.fn() };
});
import { EightSleepClient } from '../src/eightSleepClient';

function makeHap() {
  const char = () => ({ onGet: vi.fn().mockReturnThis(), onSet: vi.fn().mockReturnThis(), setProps: vi.fn().mockReturnThis() });
  const service = () => ({
    setCharacteristic: vi.fn().mockReturnThis(),
    getCharacteristic: vi.fn(() => char()),
    updateCharacteristic: vi.fn().mockReturnThis(),
  });
  const enumObj = (o: Record<string, number>) => o;
  return {
    Service: { AccessoryInformation: 'AI', HeaterCooler: 'HC', Switch: 'SW' },
    Characteristic: {
      Manufacturer: 'M', Model: 'Mo', SerialNumber: 'S', FirmwareRevision: 'F', Name: 'N', On: 'On',
      Active: enumObj({ ACTIVE: 1, INACTIVE: 0 }),
      CurrentHeaterCoolerState: enumObj({ INACTIVE: 0, IDLE: 1, HEATING: 2, COOLING: 3 }),
      TargetHeaterCoolerState: enumObj({ AUTO: 0, HEAT: 1, COOL: 2 }),
      RotationSpeed: 'RS', CurrentTemperature: 'CT',
    },
    uuid: { generate: (s: string) => `uuid:${s}` },
    HapStatusError: class extends Error {},
    HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
    _service: service,
  };
}

type Hap = ReturnType<typeof makeHap>;

function makeAccessory(displayName: string, UUID: string, hap: Hap) {
  const services = new Map<string, ReturnType<Hap['_service']>>();
  services.set('AI', hap._service());
  return {
    displayName, UUID, context: {} as Record<string, unknown>,
    getService: (s: string) => services.get(s),
    addService: (s: string) => {
      const svc = hap._service(); services.set(s, svc); return svc;
    },
  };
}

function makeApi(hap: Hap) {
  const handlers: Record<string, () => void> = {};
  return {
    hap,
    user: { storagePath: () => '/tmp/hb8s-test-storage' },
    platformAccessory: function (this: unknown, name: string, uuid: string) {
      return makeAccessory(name, uuid, hap);
    },
    registerPlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(),
    updatePlatformAccessories: vi.fn(),
    on: (evt: string, fn: () => void) => {
      handlers[evt] = fn;
    },
    fire: (evt: string) => handlers[evt]?.(),
  };
}

type FakeClient = {
  blockedUntil: number;
  me: ReturnType<typeof vi.fn>;
  device: ReturnType<typeof vi.fn>;
  user: ReturnType<typeof vi.fn>;
  setPower: ReturnType<typeof vi.fn>;
  setLevel: ReturnType<typeof vi.fn>;
  setAway: ReturnType<typeof vi.fn>;
  getAway: ReturnType<typeof vi.fn>;
};

function makeFakeClient(): FakeClient {
  return {
    blockedUntil: 0,
    me: vi.fn(),
    device: vi.fn(),
    user: vi.fn(),
    setPower: vi.fn(),
    setLevel: vi.fn(),
    setAway: vi.fn(),
    getAway: vi.fn().mockResolvedValue(false),
  };
}

function mockDiscoveryDefaults(fakeClient: FakeClient) {
  fakeClient.me.mockResolvedValue({ userId: 'U1', deviceId: 'D1' });
  fakeClient.device.mockResolvedValue({ leftUserId: 'L', rightUserId: 'R', online: true });
  fakeClient.user.mockResolvedValue({ userId: 'U1', firstName: 'A' });
}

function setup(cfgOverrides: Record<string, unknown> = {}) {
  const hap = makeHap();
  const api = makeApi(hap);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const fakeClient = makeFakeClient();
  vi.mocked(EightSleepClient).mockImplementation(function () {
    return fakeClient;
  } as never);
  const config = { platform: 'EightSleep', email: 'a@b.c', password: 'pw', pollInterval: 30, ...cfgOverrides };
  const platform = new EightSleepPlatform(
    log as unknown as Logger,
    config as unknown as PlatformConfig,
    api as unknown as API,
  );
  return { hap, api, log, fakeClient, platform };
}

/** Discovery/poll chain several promises deep; a handful of microtask ticks flushes it. */
async function flush(times = 25) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('EightSleepPlatform', () => {
  it('skips polling and warns once while rate limited', async () => {
    const { api, log, fakeClient } = setup({ pollInterval: 30 });
    mockDiscoveryDefaults(fakeClient);

    api.fire('didFinishLaunching');
    await flush();
    expect(fakeClient.device).toHaveBeenCalledTimes(1);

    fakeClient.blockedUntil = Date.now() + 10 * 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(fakeClient.device).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain('rate limiting');
  });

  it('unregisters a stale cached accessory and skips re-registering an already-cached one', async () => {
    const { api, hap, fakeClient, platform } = setup();
    mockDiscoveryDefaults(fakeClient);

    const staleAcc = makeAccessory('Old', 'uuid:eight-sleep:OLD:left', hap);
    const cachedLeftAcc = makeAccessory('Left', 'uuid:eight-sleep:D1:left', hap);
    platform.configureAccessory(staleAcc as unknown as PlatformAccessory);
    platform.configureAccessory(cachedLeftAcc as unknown as PlatformAccessory);

    api.fire('didFinishLaunching');
    await flush();

    expect(api.unregisterPlatformAccessories).toHaveBeenCalledTimes(1);
    expect(api.unregisterPlatformAccessories.mock.calls[0][2]).toEqual([staleAcc]);

    const registeredUuids = api.registerPlatformAccessories.mock.calls.map(
      c => (c[2] as { UUID: string }[])[0].UUID,
    );
    expect(registeredUuids).not.toContain('uuid:eight-sleep:D1:left');
    expect(registeredUuids).toContain('uuid:eight-sleep:D1:right');
    expect(registeredUuids).toContain('uuid:eight-sleep:D1:left:away');
    expect(registeredUuids).toContain('uuid:eight-sleep:D1:right:away');
  });

  it('unregisters cached away accessories (including the legacy household one) and registers none when awaySwitch is false', async () => {
    const { api, hap, fakeClient, platform } = setup({ awaySwitch: false });
    mockDiscoveryDefaults(fakeClient);

    const cachedAwayAcc = makeAccessory('Eight Sleep Away', 'uuid:eight-sleep:D1:away', hap);
    platform.configureAccessory(cachedAwayAcc as unknown as PlatformAccessory);

    api.fire('didFinishLaunching');
    await flush();

    expect(api.unregisterPlatformAccessories).toHaveBeenCalledTimes(1);
    expect(api.unregisterPlatformAccessories.mock.calls[0][2]).toEqual([cachedAwayAcc]);

    const registeredUuids = api.registerPlatformAccessories.mock.calls.map(
      c => (c[2] as { UUID: string }[])[0].UUID,
    );
    expect(registeredUuids.some((u: string) => u.endsWith(':away'))).toBe(false);
    expect(registeredUuids).toContain('uuid:eight-sleep:D1:left');
    expect(registeredUuids).toContain('uuid:eight-sleep:D1:right');
  });

  it('reads each switch from the authoritative away endpoint, not awaySides', async () => {
    const { api, hap, fakeClient } = setup();
    fakeClient.me.mockResolvedValue({ userId: 'L', deviceId: 'D1' });
    fakeClient.device.mockResolvedValue({
      leftUserId: 'L',
      rightUserId: 'R',
      awaySides: { leftUserId: 'L', rightUserId: 'R' },
      online: true,
    });
    fakeClient.user.mockImplementation(async (userId: string) => ({ userId, firstName: userId }));
    fakeClient.getAway.mockImplementation(async (userId: string) => userId === 'R');

    api.fire('didFinishLaunching');
    await flush();

    expect(fakeClient.getAway.mock.calls).toEqual([['L'], ['R']]);
    const registered = api.registerPlatformAccessories.mock.calls.flatMap(c => c[2] as ReturnType<typeof makeAccessory>[]);
    const leftAway = registered.find(a => a.UUID === 'uuid:eight-sleep:D1:left:away');
    const rightAway = registered.find(a => a.UUID === 'uuid:eight-sleep:D1:right:away');
    expect(leftAway?.getService(hap.Service.Switch)?.updateCharacteristic).toHaveBeenCalledWith('On', false);
    expect(rightAway?.getService(hap.Service.Switch)?.updateCharacteristic).toHaveBeenCalledWith('On', true);
  });

  it('keeps reading known users when an away device payload omits all side assignments', async () => {
    const { api, fakeClient } = setup({ pollInterval: 30 });
    mockDiscoveryDefaults(fakeClient);

    api.fire('didFinishLaunching');
    await flush();
    expect(fakeClient.getAway.mock.calls).toEqual([['L'], ['R']]);

    fakeClient.device.mockResolvedValue({ online: true });
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();

    expect(fakeClient.getAway.mock.calls).toEqual([['L'], ['R'], ['L'], ['R']]);
  });
});
