import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SideController, SideView } from '../src/sideController';

function make(opts: Partial<ConstructorParameters<typeof SideController>[0]> = {}) {
  const commands = { setPower: vi.fn(async () => undefined), setLevel: vi.fn(async () => undefined) };
  const views: SideView[] = [];
  const onWritten = vi.fn();
  const ctl = new SideController({
    userId: 'L',
    commands,
    onChange: v => views.push(v),
    onWritten,
    debounceMs: 750,
    ...opts,
  });
  return { ctl, commands, views, onWritten };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('applyState -> view', () => {
  it('maps a polled cooling state', () => {
    const { ctl } = make();
    ctl.applyState({ on: true, targetLevel: -40, currentLevel: -31, nowHeating: false });
    expect(ctl.view()).toEqual({ active: true, mode: 'cool', intensity: 40, currentState: 'cooling', currentTemperature: 23.3 });
  });

  it('off is inactive; on at level 0 is idle; positive is heating', () => {
    const { ctl } = make();
    ctl.applyState({ on: false, targetLevel: 0, currentLevel: 0, nowHeating: false });
    expect(ctl.view().currentState).toBe('inactive');
    ctl.applyState({ on: true, targetLevel: 0, currentLevel: 0, nowHeating: false });
    expect(ctl.view().currentState).toBe('idle');
    ctl.applyState({ on: true, targetLevel: 15, currentLevel: 3, nowHeating: true });
    expect(ctl.view().currentState).toBe('heating');
    expect(ctl.view().mode).toBe('heat');
  });

  it('level 0 keeps the last chosen mode (default cool)', () => {
    const { ctl } = make();
    expect(ctl.view().mode).toBe('cool');
    ctl.applyState({ on: true, targetLevel: 20, currentLevel: 0, nowHeating: false });
    ctl.applyState({ on: true, targetLevel: 0, currentLevel: 0, nowHeating: false });
    expect(ctl.view().mode).toBe('heat');
  });
});

describe('writes', () => {
  it('setActive writes immediately and updates optimistically', async () => {
    const { ctl, commands, views, onWritten } = make();
    await ctl.setActive(true);
    expect(commands.setPower).toHaveBeenCalledWith('L', true);
    expect(views.at(-1)?.active).toBe(true);
    expect(onWritten).toHaveBeenCalledTimes(1);
    await ctl.setActive(false);
    expect(commands.setPower).toHaveBeenLastCalledWith('L', false);
    expect(views.at(-1)?.currentState).toBe('inactive');
  });

  it('coalesces a burst of slider moves into one setLevel', async () => {
    const { ctl, commands, onWritten } = make();
    ctl.setMode('cool');
    for (const v of [10, 20, 30, 35]) {
      ctl.setIntensity(v);
      vi.advanceTimersByTime(100);
    }
    expect(commands.setLevel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(750);
    expect(commands.setLevel).toHaveBeenCalledTimes(1);
    expect(commands.setLevel).toHaveBeenCalledWith('L', -35);
    expect(onWritten).toHaveBeenCalledTimes(1);
    expect(ctl.view()).toMatchObject({ active: true, mode: 'cool', intensity: 35, currentState: 'cooling' });
  });

  it('mode flip keeps magnitude', async () => {
    const { ctl, commands } = make();
    ctl.applyState({ on: true, targetLevel: -40, currentLevel: -40, nowHeating: false });
    ctl.setMode('heat');
    await vi.advanceTimersByTimeAsync(750);
    expect(commands.setLevel).toHaveBeenCalledWith('L', 40);
  });

  it('mode flip with magnitude 0 uses lastMagnitude (default 20)', async () => {
    const { ctl, commands } = make();
    ctl.applyState({ on: true, targetLevel: 0, currentLevel: 0, nowHeating: false });
    ctl.setMode('cool');
    await vi.advanceTimersByTimeAsync(750);
    expect(commands.setLevel).toHaveBeenCalledWith('L', -20);
  });

  it('remembers the last non-zero magnitude across a zero', async () => {
    const { ctl, commands } = make();
    ctl.setMode('heat');
    ctl.setIntensity(60);
    await vi.advanceTimersByTimeAsync(750);
    ctl.setIntensity(0);
    await vi.advanceTimersByTimeAsync(750);
    expect(commands.setLevel).toHaveBeenLastCalledWith('L', 0);
    expect(ctl.lastMagnitude).toBe(60);
    ctl.setMode('cool');
    await vi.advanceTimersByTimeAsync(750);
    expect(commands.setLevel).toHaveBeenLastCalledWith('L', -60);
  });

  it('restores lastMagnitude from options', async () => {
    const { ctl, commands } = make({ lastMagnitude: 45 });
    ctl.setMode('heat');
    await vi.advanceTimersByTimeAsync(750);
    expect(commands.setLevel).toHaveBeenCalledWith('L', 45);
  });

  it('ignores polled state while a write is pending, then accepts it', async () => {
    const { ctl } = make();
    ctl.setIntensity(50);
    ctl.applyState({ on: false, targetLevel: 0, currentLevel: 0, nowHeating: false });
    expect(ctl.view().intensity).toBe(50);
    await vi.advanceTimersByTimeAsync(750);
    ctl.applyState({ on: true, targetLevel: -50, currentLevel: -10, nowHeating: false });
    expect(ctl.view()).toMatchObject({ active: true, intensity: 50, mode: 'cool' });
  });

  it('reports command failures through onError and keeps running', async () => {
    const onError = vi.fn();
    const { ctl, commands } = make({ onError });
    commands.setLevel.mockRejectedValueOnce(new Error('boom'));
    ctl.setIntensity(30);
    await vi.advanceTimersByTimeAsync(750);
    expect(onError).toHaveBeenCalledTimes(1);
    ctl.setIntensity(31);
    await vi.advanceTimersByTimeAsync(750);
    expect(commands.setLevel).toHaveBeenCalledTimes(2);
  });

  it('dispose cancels a pending write', async () => {
    const { ctl, commands } = make();
    ctl.setIntensity(30);
    ctl.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    expect(commands.setLevel).not.toHaveBeenCalled();
  });

  it('setActive(false) cancels a pending level write', async () => {
    const { ctl, commands } = make();
    ctl.setIntensity(40);
    await ctl.setActive(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(commands.setLevel).not.toHaveBeenCalled();
    expect(commands.setPower).toHaveBeenCalledWith('L', false);
    expect(ctl.view().active).toBe(false);
  });

  it('ignores polled target state while a write is in flight, then accepts it', async () => {
    let resolve!: () => void;
    const { ctl, commands } = make();
    commands.setLevel.mockImplementationOnce(() => new Promise<void>(r => {
      resolve = r;
    }));
    ctl.setMode('cool');
    ctl.setIntensity(50);
    await vi.advanceTimersByTimeAsync(750);
    expect(commands.setLevel).toHaveBeenCalledTimes(1);
    ctl.applyState({ on: false, targetLevel: 0, currentLevel: 0, nowHeating: false });
    expect(ctl.view()).toMatchObject({ active: true, intensity: 50, mode: 'cool' });
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    ctl.applyState({ on: true, targetLevel: -50, currentLevel: -20, nowHeating: false });
    expect(ctl.view()).toMatchObject({ active: true, intensity: 50, currentTemperature: 25 });
  });

  it('still tracks currentLevel from polls while a write is pending', () => {
    const { ctl } = make();
    ctl.setIntensity(50);
    ctl.applyState({ on: false, targetLevel: 0, currentLevel: -20, nowHeating: false });
    expect(ctl.view().currentTemperature).toBe(25);
    expect(ctl.view().intensity).toBe(50);
  });

  it('dispose during an in-flight write suppresses callbacks', async () => {
    let resolve!: () => void;
    const { ctl, commands, onWritten } = make();
    commands.setLevel.mockImplementationOnce(() => new Promise<void>(r => {
      resolve = r;
    }));
    ctl.setIntensity(30);
    await vi.advanceTimersByTimeAsync(750);
    ctl.dispose();
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(onWritten).not.toHaveBeenCalled();
  });

  it('serializes overlapping flushes', async () => {
    let resolve!: () => void;
    const { ctl, commands } = make();
    commands.setLevel.mockImplementationOnce(() => new Promise<void>(r => {
      resolve = r;
    }));
    ctl.setIntensity(30);
    await vi.advanceTimersByTimeAsync(750);
    ctl.setIntensity(60);
    await vi.advanceTimersByTimeAsync(750);
    expect(commands.setLevel).toHaveBeenCalledTimes(1);
    resolve();
    await vi.advanceTimersByTimeAsync(750);
    expect(commands.setLevel).toHaveBeenCalledTimes(2);
    expect(commands.setLevel).toHaveBeenLastCalledWith('L', -60);
  });

  it('slider to 0 on an off side does not power it on', async () => {
    const { ctl, commands, onWritten } = make();
    await ctl.setActive(false);
    ctl.setIntensity(0);
    await vi.advanceTimersByTimeAsync(750);
    expect(commands.setLevel).not.toHaveBeenCalled();
    expect(commands.setPower).toHaveBeenCalledTimes(1);
    expect(onWritten).toHaveBeenCalledTimes(1);
    expect(ctl.view()).toMatchObject({ active: false, intensity: 0, currentState: 'inactive' });
  });
});
