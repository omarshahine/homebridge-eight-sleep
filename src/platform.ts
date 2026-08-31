import { join } from 'node:path';
import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';

import { AwayAccessory } from './awayAccessory';
import { EightSleepClient, RateLimitedError } from './eightSleepClient';
import { PollHealth } from './health';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { SideAccessory } from './sideAccessory';
import { SideAssignment, isUserAway, resolveSideAssignments, sideState } from './sides';
import { TokenStore } from './tokenStore';
import { DeviceResult, EightSleepConfig, Side } from './types';

const MIN_POLL_S = 30;
const DEFAULT_POLL_S = 60;
const CONFIRM_POLL_MS = 3000;
const DISCOVERY_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 480_000, 600_000];

export class EightSleepPlatform implements DynamicPlatformPlugin {
  public readonly cached: PlatformAccessory[] = [];

  private readonly cfg: EightSleepConfig;
  private readonly pollMs: number;
  private readonly health = new PollHealth();
  private client?: EightSleepClient;
  private deviceId?: string;
  private model = 'Pod';
  private firmware = '0';
  private sides = new Map<Side, SideAccessory>();
  private aways = new Map<Side, AwayAccessory>();
  private pollTimer?: NodeJS.Timeout;
  private confirmTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private polling = false;
  private stopped = false;
  private warnedBlocked = false;
  private warnedUnmatched = new Set<Side>();

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.cfg = config as EightSleepConfig;
    const requested = Number(this.cfg.pollInterval ?? DEFAULT_POLL_S);
    this.pollMs = Math.max(MIN_POLL_S, Number.isFinite(requested) ? requested : DEFAULT_POLL_S) * 1000;

    if (!this.cfg.email || !this.cfg.password) {
      this.log.error('email and password are required; the plugin will not start');
      return;
    }

    this.client = new EightSleepClient({
      email: this.cfg.email,
      password: this.cfg.password,
      store: new TokenStore(join(this.api.user.storagePath(), PLUGIN_NAME)),
      log: { debug: m => this.log.debug(m), warn: m => this.log.warn(m) },
    });

    this.api.on('didFinishLaunching', () => void this.start(0));
    this.api.on('shutdown', () => this.stop());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug(`Loading accessory from cache: ${accessory.displayName}`);
    this.cached.push(accessory);
  }

  // ---- lifecycle ------------------------------------------------------------

  private async start(attempt: number): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      await this.discover();
    } catch (err) {
      const delay = DISCOVERY_BACKOFF_MS[Math.min(attempt, DISCOVERY_BACKOFF_MS.length - 1)];
      this.log.error(`Discovery failed (${this.describe(err)}); retrying in ${delay / 1000}s`);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        void this.start(attempt + 1);
      }, delay);
      return;
    }
    if (this.stopped) {
      return;
    }
    this.pollTimer = setInterval(() => void this.poll('interval'), this.pollMs);
    this.log.info(`Polling every ${this.pollMs / 1000}s`);
  }

  private stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    if (this.confirmTimer) {
      clearTimeout(this.confirmTimer);
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    for (const side of this.sides.values()) {
      side.dispose();
    }
    if (this.cached.length > 0) {
      this.api.updatePlatformAccessories(this.cached);
    }
  }

  // ---- discovery ------------------------------------------------------------

  private async discover(): Promise<void> {
    const client = this.client!;
    const { deviceId } = await client.me();
    this.deviceId = deviceId;
    const device = await client.device(deviceId);
    this.model = device.modelString || 'Pod';
    this.firmware = device.firmwareVersion || '0';

    const assignments = resolveSideAssignments(device);
    if (assignments.length === 0) {
      throw new Error('no users assigned to either side of the pod');
    }

    const names = new Map<string, string | undefined>();
    for (const a of assignments) {
      try {
        names.set(a.userId, (await client.user(a.userId)).firstName);
      } catch (err) {
        this.log.warn(`Could not read name for a user (${this.describe(err)}); using side label`);
      }
    }

    const wanted = new Set<string>();
    for (const a of assignments) {
      const uuid = this.api.hap.uuid.generate(`eight-sleep:${deviceId}:${a.side}`);
      wanted.add(uuid);
      const displayName = this.sideDisplayName(a, names.get(a.userId));
      const accessory = this.obtainAccessory(uuid, displayName);
      const existing = this.sides.get(a.side);
      if (existing) {
        existing.setUserId(a.userId);
        continue;
      }
      this.sides.set(a.side, new SideAccessory({
        api: this.api,
        log: this.log,
        accessory,
        client,
        side: a.side,
        userId: a.userId,
        displayName,
        model: this.model,
        firmware: this.firmware,
        serial: `${deviceId}-${a.side}`,
        isHealthy: () => this.health.healthy,
        onWritten: () => this.scheduleConfirmPoll(),
      }));
      this.log.info(`Discovered ${displayName} (${a.side})`);
    }

    if (this.cfg.awaySwitch !== false) {
      // Eight Sleep tracks away mode per person, so each side gets its own switch.
      for (const a of assignments) {
        const uuid = this.api.hap.uuid.generate(`eight-sleep:${deviceId}:${a.side}:away`);
        wanted.add(uuid);
        const displayName = this.awayDisplayName(a, names.get(a.userId));
        const accessory = this.obtainAccessory(uuid, displayName);
        const existing = this.aways.get(a.side);
        if (existing) {
          existing.setUserId(a.userId);
          continue;
        }
        this.aways.set(a.side, new AwayAccessory({
          api: this.api,
          log: this.log,
          accessory,
          client,
          userId: a.userId,
          displayName,
          model: this.model,
          firmware: this.firmware,
          serial: `${deviceId}-${a.side}-away`,
          isHealthy: () => this.health.healthy,
          onWritten: () => this.scheduleConfirmPoll(),
        }));
      }
    }

    const stale = this.cached.filter(a => !wanted.has(a.UUID));
    if (stale.length > 0) {
      this.log.info(`Removing ${stale.length} stale accessor${stale.length === 1 ? 'y' : 'ies'}`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const a of stale) {
        this.cached.splice(this.cached.indexOf(a), 1);
      }
    }

    this.applyDevice(device, assignments);
  }

  private sideDisplayName(a: SideAssignment, firstName?: string): string {
    const override = a.side === 'left' ? this.cfg.leftName : a.side === 'right' ? this.cfg.rightName : undefined;
    if (override && override.trim()) {
      return override.trim();
    }
    if (firstName) {
      return `${firstName}'s Side`;
    }
    return a.side === 'solo' ? 'Bed' : a.side === 'left' ? 'Left Side' : 'Right Side';
  }

  private awayDisplayName(a: SideAssignment, firstName?: string): string {
    const override = a.side === 'left' ? this.cfg.leftName : a.side === 'right' ? this.cfg.rightName : undefined;
    if (override && override.trim()) {
      return `${override.trim()} Away`;
    }
    if (firstName) {
      return `${firstName} Away`;
    }
    return a.side === 'solo' ? 'Bed Away' : a.side === 'left' ? 'Left Away' : 'Right Away';
  }

  private obtainAccessory(uuid: string, displayName: string): PlatformAccessory {
    const existing = this.cached.find(a => a.UUID === uuid);
    if (existing) {
      if (existing.displayName !== displayName) {
        existing.displayName = displayName;
        this.api.updatePlatformAccessories([existing]);
      }
      return existing;
    }
    const accessory = new this.api.platformAccessory(displayName, uuid);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.cached.push(accessory);
    return accessory;
  }

  // ---- polling --------------------------------------------------------------

  private scheduleConfirmPoll(): void {
    if (this.stopped) {
      return;
    }
    if (this.confirmTimer) {
      clearTimeout(this.confirmTimer);
    }
    this.confirmTimer = setTimeout(() => {
      this.confirmTimer = undefined;
      void this.poll('confirm');
    }, CONFIRM_POLL_MS);
  }

  private async poll(reason: 'interval' | 'confirm'): Promise<void> {
    if (this.stopped || !this.client || !this.deviceId) {
      return;
    }
    if (this.polling) {
      if (reason === 'confirm') {
        this.scheduleConfirmPoll();
      }
      return;
    }
    if (this.client.blockedUntil <= Date.now()) {
      this.warnedBlocked = false;
    }
    if (this.client.blockedUntil > Date.now()) {
      if (!this.warnedBlocked) {
        const s = Math.ceil((this.client.blockedUntil - Date.now()) / 1000);
        this.log.warn(`Eight Sleep is rate limiting us; pausing polls for ${s}s`);
        this.warnedBlocked = true;
      }
      return;
    }
    this.polling = true;
    try {
      const device = await this.client.device(this.deviceId);
      const assignments = resolveSideAssignments(device);
      this.applyDevice(device, assignments);
      if (this.cfg.debug) {
        this.log.info(`[poll:${reason}] ${this.summarize(device, assignments)}`);
      }
    } catch (err) {
      if (err instanceof RateLimitedError) {
        if (!this.warnedBlocked) {
          this.log.warn(err.message);
          this.warnedBlocked = true;
        }
      } else {
        this.health.recordFailure();
        const n = this.health.consecutiveFailures;
        if (n === 1 || n % 10 === 0) {
          this.log.error(`Poll failed (${n} in a row): ${this.describe(err)}`);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private applyDevice(device: DeviceResult, assignments: SideAssignment[]): void {
    const online = device.online !== false;
    const wasHealthy = this.health.healthy;
    this.health.recordSuccess(online);
    if (!online && wasHealthy) {
      this.log.warn('Pod reports offline');
    } else if (online && !wasHealthy) {
      this.log.info('Pod is back online');
    }

    for (const a of assignments) {
      const side = this.sides.get(a.side);
      if (!side) {
        if (!this.warnedUnmatched.has(a.side)) {
          this.log.warn(`Side "${a.side}" appeared after discovery; restart Homebridge to add its accessory`);
          this.warnedUnmatched.add(a.side);
        }
        continue;
      }
      side.setUserId(a.userId);
      side.controller.applyState(sideState(device, a.prefix));
      const away = this.aways.get(a.side);
      if (away) {
        away.setUserId(a.userId);
        away.applyAway(isUserAway(device, a.userId));
      }
    }
  }

  private summarize(device: DeviceResult, assignments: SideAssignment[]): string {
    const parts = assignments.map(a => {
      const s = sideState(device, a.prefix);
      return `${a.side}: ${s.on ? 'on' : 'off'} target=${s.targetLevel} current=${s.currentLevel}`;
    });
    parts.push(`away=${assignments.map(a => `${a.side}:${isUserAway(device, a.userId)}`).join('/')}`);
    parts.push(`online=${device.online !== false}`);
    return parts.join(', ');
  }

  private describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
