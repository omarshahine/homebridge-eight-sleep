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
  private readonly service: Service;
  private userId: string;
  private away = false;

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
        this.applyAway(target);
        try {
          await deps.client.setAway(this.userId, target);
        } catch (err) {
          deps.log.error(`[${deps.displayName}] failed to set away=${target}: ${String(err)}`);
        }
        deps.onWritten();
      });
  }

  setUserId(userId: string): void {
    this.userId = userId;
  }

  applyAway(away: boolean): void {
    if (this.away !== away) {
      this.deps.log.info(`[${this.deps.displayName}] ${away ? 'on' : 'off'}`);
    }
    this.away = away;
    this.service.updateCharacteristic(this.deps.api.hap.Characteristic.On, away);
  }
}
