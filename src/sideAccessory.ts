import { API, CharacteristicValue, Logger, PlatformAccessory, Service } from 'homebridge';

import { EightSleepClient } from './eightSleepClient';
import { SideController, SideView } from './sideController';
import { Mode, Side } from './types';

// Threshold dial range = pseudoCelsius(-100)..pseudoCelsius(+100), widened to whole half-degrees.
const THRESHOLD_MIN_C = 12.5;
const THRESHOLD_MAX_C = 43.5;
const THRESHOLD_STEP_C = 0.5;

/** HAP thresholds use a 0.5 C step; snap so updateCharacteristic never pushes an off-step value. */
function halfDegree(celsius: number): number {
  const snapped = Math.round(celsius * 2) / 2;
  return Math.max(THRESHOLD_MIN_C, Math.min(THRESHOLD_MAX_C, snapped));
}

export interface SideAccessoryContext {
  side: Side;
  userId: string;
  lastMagnitude?: number;
}

export interface SideAccessoryDeps {
  api: API;
  log: Logger;
  accessory: PlatformAccessory;
  client: EightSleepClient;
  side: Side;
  userId: string;
  displayName: string;
  model: string;
  firmware: string;
  serial: string;
  isHealthy: () => boolean;
  onWritten: () => void;
}

/** Binds one bed side to a HomeKit HeaterCooler service. */
export class SideAccessory {
  public readonly controller: SideController;
  private readonly service: Service;

  constructor(private readonly deps: SideAccessoryDeps) {
    const { api, accessory } = deps;
    const { Service: S, Characteristic: C } = api.hap;
    const ctx = accessory.context as SideAccessoryContext;
    ctx.side = deps.side;
    ctx.userId = deps.userId;

    accessory.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Eight Sleep')
      .setCharacteristic(C.Model, deps.model)
      .setCharacteristic(C.SerialNumber, deps.serial)
      .setCharacteristic(C.FirmwareRevision, deps.firmware);

    this.service = accessory.getService(S.HeaterCooler) ?? accessory.addService(S.HeaterCooler);
    this.service.setCharacteristic(C.Name, deps.displayName);

    this.controller = new SideController({
      userId: deps.userId,
      commands: deps.client,
      lastMagnitude: ctx.lastMagnitude,
      onChange: view => this.push(view),
      onWritten: () => {
        ctx.lastMagnitude = this.controller.lastMagnitude;
        deps.onWritten();
      },
      onError: err => deps.log.error(`[${deps.displayName}] write failed: ${String(err)}`),
    });

    this.service.getCharacteristic(C.Active)
      .onGet(() => this.guard(() => this.controller.view().active ? C.Active.ACTIVE : C.Active.INACTIVE))
      .onSet(value => this.controller.setActive(value === C.Active.ACTIVE));

    this.service.getCharacteristic(C.CurrentHeaterCoolerState)
      .onGet(() => this.guard(() => this.currentStateValue(this.controller.view())));

    this.service.getCharacteristic(C.TargetHeaterCoolerState)
      .setProps({ validValues: [C.TargetHeaterCoolerState.HEAT, C.TargetHeaterCoolerState.COOL] })
      .onGet(() => this.guard(() => this.targetStateValue(this.controller.view().mode)))
      .onSet(value => this.controller.setMode(value === C.TargetHeaterCoolerState.HEAT ? 'heat' : 'cool'));

    this.service.getCharacteristic(C.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 5 })
      .onGet(() => this.guard(() => this.controller.view().intensity))
      .onSet(value => this.controller.setIntensity(Number(value)));

    this.service.getCharacteristic(C.CurrentTemperature)
      .setProps({ minValue: 0, maxValue: 50, minStep: 0.1 })
      .onGet(() => this.guard(() => this.controller.view().currentTemperature));

    // Home renders the HeaterCooler tile as "<Mode> to <threshold>"; without these it shows "(null)".
    // Both thresholds are the same target level on the pseudo-temperature scale.
    for (const threshold of [C.CoolingThresholdTemperature, C.HeatingThresholdTemperature]) {
      this.service.getCharacteristic(threshold)
        .setProps({ minValue: THRESHOLD_MIN_C, maxValue: THRESHOLD_MAX_C, minStep: THRESHOLD_STEP_C })
        .onGet(() => this.guard(() => halfDegree(this.controller.view().targetTemperature)))
        .onSet(value => this.controller.setTargetTemperature(Number(value)));
    }
  }

  setUserId(userId: string): void {
    if (this.controller.userId !== userId) {
      this.deps.log.info(`[${this.deps.displayName}] user changed for this side`);
      this.controller.userId = userId;
      (this.deps.accessory.context as SideAccessoryContext).userId = userId;
    }
  }

  dispose(): void {
    this.controller.dispose();
  }

  private guard<T extends CharacteristicValue>(read: () => T): T {
    if (!this.deps.isHealthy()) {
      throw new this.deps.api.hap.HapStatusError(this.deps.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return read();
  }

  private push(view: SideView): void {
    const C = this.deps.api.hap.Characteristic;
    this.service.updateCharacteristic(C.Active, view.active ? C.Active.ACTIVE : C.Active.INACTIVE);
    this.service.updateCharacteristic(C.CurrentHeaterCoolerState, this.currentStateValue(view));
    this.service.updateCharacteristic(C.TargetHeaterCoolerState, this.targetStateValue(view.mode));
    this.service.updateCharacteristic(C.RotationSpeed, view.intensity);
    this.service.updateCharacteristic(C.CurrentTemperature, view.currentTemperature);
    const target = halfDegree(view.targetTemperature);
    this.service.updateCharacteristic(C.CoolingThresholdTemperature, target);
    this.service.updateCharacteristic(C.HeatingThresholdTemperature, target);
  }

  private currentStateValue(view: SideView): number {
    const C = this.deps.api.hap.Characteristic.CurrentHeaterCoolerState;
    switch (view.currentState) {
      case 'heating': return C.HEATING;
      case 'cooling': return C.COOLING;
      case 'idle': return C.IDLE;
      default: return C.INACTIVE;
    }
  }

  private targetStateValue(mode: Mode): number {
    const C = this.deps.api.hap.Characteristic.TargetHeaterCoolerState;
    return mode === 'heat' ? C.HEAT : C.COOL;
  }
}
