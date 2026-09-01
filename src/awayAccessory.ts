import { API, Logger, PlatformAccessory, Service } from 'homebridge';

import { EightSleepClient } from './eightSleepClient';

export interface AwayAccessoryDeps {
  api: API;
  log: Logger;
  accessory: PlatformAccessory;
  client: EightSleepClient;
  userId: string;
  displayName: string;
  model: string;
  firmware: string;
  serial: string;
  isHealthy: () => boolean;
  onWritten: () => void;
}

/** One user's away mode as a HomeKit Switch (Eight Sleep tracks away per person, not per pod). */
export class AwayAccessory {
  private static readonly CONFIRM_TIMEOUT_MS = 60_000;
  private readonly service: Service;
  private userId: string;
  private away = false;
  private stableAway = false;
  private pending?: { target: boolean; generation: number; expiresAt?: number };
  private writeGeneration = 0;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: AwayAccessoryDeps) {
    const { api, accessory } = deps;
    const { Service: S, Characteristic: C } = api.hap;
    this.userId = deps.userId;

    accessory.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Eight Sleep')
      .setCharacteristic(C.Model, deps.model)
      .setCharacteristic(C.SerialNumber, deps.serial)
      .setCharacteristic(C.FirmwareRevision, deps.firmware);

    this.service = accessory.getService(S.Switch) ?? accessory.addService(S.Switch);
    this.service.setCharacteristic(C.Name, deps.displayName);

    this.service.getCharacteristic(C.On)
      .onGet(() => {
        if (!deps.isHealthy()) {
          throw new api.hap.HapStatusError(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        return this.away;
      })
      .onSet(async value => {
        const target = value === true;
        const generation = ++this.writeGeneration;
        const userId = this.userId;
        this.setDisplayedAway(target);
        this.pending = { target, generation };
        deps.log.info(`[${deps.displayName}] requesting ${target ? 'on (awayPeriod.start)' : 'off (awayPeriod.end)'}`);

        // HomeKit may overlap writes. eightctl is synchronous, so serialize
        // requests to preserve arrival order and guarantee the last intent wins.
        const request = this.writeTail.then(() => deps.client.setAway(userId, target));
        this.writeTail = request.catch(() => undefined);
        try {
          await request;
          this.stableAway = target;
          if (this.pending?.generation === generation) {
            this.pending.expiresAt = Date.now() + AwayAccessory.CONFIRM_TIMEOUT_MS;
          }
        } catch (err) {
          if (this.pending?.generation === generation) {
            this.pending = undefined;
            this.setDisplayedAway(this.stableAway);
          }
          deps.log.error(`[${deps.displayName}] failed to set away=${target}: ${String(err)}`);
          throw new api.hap.HapStatusError(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        } finally {
          if (this.writeGeneration === generation) {
            deps.onWritten();
          }
        }
      });
  }

  setUserId(userId: string): void {
    this.userId = userId;
  }

  get isAway(): boolean {
    return this.away;
  }

  get targetUserId(): string {
    return this.userId;
  }

  get displayName(): string {
    return this.deps.displayName;
  }

  get confirmationPending(): boolean {
    this.expirePendingConfirmation();
    return this.pending !== undefined;
  }

  /** Applies an API read without letting eventual consistency undo an accepted write. */
  applyAway(away: boolean): void {
    this.expirePendingConfirmation();
    if (this.pending) {
      if (this.pending.expiresAt !== undefined && away === this.pending.target) {
        this.pending = undefined;
      } else {
        this.deps.log.debug(`[${this.deps.displayName}] API still reports ${away ? 'on' : 'off'}; waiting for accepted write`);
        return;
      }
    }
    this.stableAway = away;
    this.setDisplayedAway(away);
  }

  private expirePendingConfirmation(): void {
    if (this.pending?.expiresAt !== undefined && Date.now() >= this.pending.expiresAt) {
      this.deps.log.warn(`[${this.deps.displayName}] API did not confirm the accepted write within 60s`);
      this.pending = undefined;
    }
  }

  private setDisplayedAway(away: boolean): void {
    if (this.away !== away) {
      this.deps.log.info(`[${this.deps.displayName}] ${away ? 'on' : 'off'}`);
    }
    this.away = away;
    this.service.updateCharacteristic(this.deps.api.hap.Characteristic.On, away);
  }
}
