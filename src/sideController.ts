import { composeLevel, intensityOf, modeOf, pseudoCelsius } from './mapping';
import { Mode, SideState } from './types';

export type CurrentState = 'inactive' | 'idle' | 'heating' | 'cooling';

export interface SideView {
  active: boolean;
  mode: Mode;
  intensity: number;
  currentState: CurrentState;
  currentTemperature: number;
}

export interface SideCommands {
  setPower(userId: string, on: boolean): Promise<void>;
  setLevel(userId: string, level: number): Promise<void>;
}

export interface SideControllerOptions {
  userId: string;
  commands: SideCommands;
  onChange: (view: SideView) => void;
  onWritten?: () => void;
  onError?: (err: unknown) => void;
  lastMagnitude?: number;
  debounceMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

const DEFAULT_MAGNITUDE = 20;
const DEFAULT_DEBOUNCE_MS = 750;

/**
 * Per-side state machine. Holds the last known state, applies HomeKit writes
 * optimistically, and coalesces slider/mode writes into one setLevel call.
 * No Homebridge types here so it can be unit-tested directly.
 */
export class SideController {
  public userId: string;

  private on = false;
  private targetLevel = 0;
  private currentLevel = 0;
  private mode: Mode = 'cool';
  private magnitude: number;
  private pendingIntensity?: number;
  private pendingMode?: Mode;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly debounceMs: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  constructor(private readonly opts: SideControllerOptions) {
    this.userId = opts.userId;
    this.magnitude = opts.lastMagnitude && opts.lastMagnitude > 0 ? opts.lastMagnitude : DEFAULT_MAGNITUDE;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
  }

  get lastMagnitude(): number {
    return this.magnitude;
  }

  view(): SideView {
    let currentState: CurrentState = 'inactive';
    if (this.on) {
      currentState = this.targetLevel > 0 ? 'heating' : this.targetLevel < 0 ? 'cooling' : 'idle';
    }
    return {
      active: this.on,
      mode: this.mode,
      intensity: intensityOf(this.targetLevel),
      currentState,
      currentTemperature: pseudoCelsius(this.currentLevel),
    };
  }

  /** Apply a polled state. Skipped while a debounced write is pending so the slider doesn't snap back. */
  applyState(s: SideState): void {
    if (this.timer) {
      return;
    }
    this.on = s.on;
    this.targetLevel = s.targetLevel;
    this.currentLevel = s.currentLevel;
    this.mode = modeOf(s.targetLevel, this.mode);
    if (s.targetLevel !== 0) {
      this.magnitude = intensityOf(s.targetLevel);
    }
    this.opts.onChange(this.view());
  }

  async setActive(on: boolean): Promise<void> {
    this.on = on;
    this.opts.onChange(this.view());
    try {
      await this.opts.commands.setPower(this.userId, on);
      this.opts.onWritten?.();
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  /** Optimistic: the tile flips sign immediately; the write happens after the debounce. */
  setMode(mode: Mode): void {
    this.pendingMode = mode;
    this.mode = mode;
    this.targetLevel = composeLevel(mode, intensityOf(this.targetLevel) || this.magnitude);
    this.opts.onChange(this.view());
    this.schedule();
  }

  /** Optimistic: the slider stays where the user put it; the write happens after the debounce. */
  setIntensity(intensity: number): void {
    const v = Math.max(0, Math.min(100, Math.round(intensity)));
    this.pendingIntensity = v;
    if (v > 0) {
      this.magnitude = v;
    }
    this.targetLevel = composeLevel(this.mode, v);
    this.opts.onChange(this.view());
    this.schedule();
  }

  dispose(): void {
    if (this.timer) {
      this.clearTimeoutFn(this.timer);
      this.timer = undefined;
    }
    this.pendingIntensity = undefined;
    this.pendingMode = undefined;
  }

  private schedule(): void {
    if (this.timer) {
      this.clearTimeoutFn(this.timer);
    }
    this.timer = this.setTimeoutFn(() => {
      this.timer = undefined;
      void this.flush();
    }, this.debounceMs);
  }

  private async flush(): Promise<void> {
    const mode = this.pendingMode ?? this.mode;
    const intensity = this.pendingIntensity ?? (intensityOf(this.targetLevel) || this.magnitude);
    this.pendingIntensity = undefined;
    this.pendingMode = undefined;

    const level = composeLevel(mode, intensity);
    this.mode = mode;
    this.targetLevel = level;
    this.on = true; // setLevel implies "smart"
    this.opts.onChange(this.view());

    try {
      await this.opts.commands.setLevel(this.userId, level);
      this.opts.onWritten?.();
    } catch (err) {
      this.opts.onError?.(err);
    }
  }
}
