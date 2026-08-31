import { API, Logger, PlatformAccessory, Service } from 'homebridge';

import { EightSleepClient } from './eightSleepClient';

export interface AwayAccessoryDeps {
  api: API;
  log: Logger;
  accessory: PlatformAccessory;
  client: EightSleepClient;
  model: string;
  firmware: string;
  serial: string;
  isHealthy: () => boolean;
  onWritten: () => void;
}

/** Household away mode as a HomeKit Switch. On = every discovered user is away. */
export class AwayAccessory {
  private readonly service: Service;
  private userIds: string[] = [];
  private away = false;

  constructor(private readonly deps: AwayAccessoryDeps) {
    const { api, accessory } = deps;
    const { Service: S, Characteristic: C } = api.hap;

    accessory.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Eight Sleep')
      .setCharacteristic(C.Model, deps.model)
      .setCharacteristic(C.SerialNumber, deps.serial)
      .setCharacteristic(C.FirmwareRevision, deps.firmware);

    this.service = accessory.getService(S.Switch) ?? accessory.addService(S.Switch);
    this.service.setCharacteristic(C.Name, accessory.displayName);

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
        for (const userId of this.userIds) {
          try {
            await deps.client.setAway(userId, target);
          } catch (err) {
            deps.log.error(`[Away] failed to set away=${target}: ${String(err)}`);
          }
        }
        deps.onWritten();
      });
  }

  setUserIds(userIds: string[]): void {
    this.userIds = [...new Set(userIds)];
  }

  applyAway(away: boolean): void {
    if (this.away !== away) {
      this.deps.log.info(`[Away] ${away ? 'on' : 'off'}`);
    }
    this.away = away;
    this.service.updateCharacteristic(this.deps.api.hap.Characteristic.On, away);
  }
}
