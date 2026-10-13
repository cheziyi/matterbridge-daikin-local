/**
 * @file src/accessory/daikinAccessory.ts
 * @description This file contains the bridge between one Daikin air conditioner and its Matter endpoints.
 * @author Calvin Che
 * @created 2026-10-12
 * @version 1.0.0
 * @license Apache-2.0
 *
 * Copyright 2026 Calvin Che.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  type DaikinCapabilities,
  type DaikinClient,
  type DaikinControl,
  type DaikinSensors,
  type DaikinState,
  type FanSpeed,
  SPECIAL_MODES,
  type SpecialMode,
} from 'daikin-local-control';
import type { MatterbridgeEndpoint } from 'matterbridge';
import type { AnsiLogger } from 'matterbridge/logger';
import type { ActionContext } from 'matterbridge/matter';
import { BridgedDeviceBasicInformation, FanControl, OnOff, Thermostat } from 'matterbridge/matter/clusters';

import type { DaikinDeviceConfig } from '../config.js';
import { addReportedSensors, getSwitchableSpecialModes, hasFanAuto, noReportedSensors, type ReportedSensors } from '../controls.js';
import { getErrorMessage } from '../errors.js';
import { toOperatingMode } from '../mapping.js';
import { createAirConditionerEndpoint, createFanEndpoint, createOutdoorTemperatureEndpoint, createSwitchEndpoint, type EndpointIdentity } from './endpoints.js';
import { type AccessoryLayout, getAccessoryLayout } from './layout.js';
import { type AccessoryEndpoints, applySensors, applyState, readFanSpeed } from './matterState.js';
import { addHiddenSettings, PendingCommand, type SetpointKind, type SwingAxis } from './pendingCommand.js';

/** How long, in milliseconds, the writes of a controller are collected before they are sent as one command. */
export const defaultCommandDelayInMs = 300;

/** How many reads in a row have to fail before the device is reported as unreachable. */
const unreachableAfterFailures = 2;

/** What each special mode is called in Matter and in the log: Daikin's own names. */
const specialModeLabels: Readonly<Record<SpecialMode, string>> = { powerful: 'Powerful', econo: 'Econo', streamer: 'Streamer' };

/** The modes some Matter apps cannot select, which can each get a switch of their own. */
type SwitchedMode = 'dehumidify' | 'fan';

export interface DaikinAccessoryOptions {
  config: DaikinDeviceConfig;
  capabilities: DaikinCapabilities;
  /** The readings the unit has given, which each get their place in Matter. Defaults to none. */
  reportedSensors?: ReportedSensors;
  client: DaikinClient;
  log: AnsiLogger;
  /** The vendor id of the bridge, used for the bridged device information. */
  vendorId: number;
  /** How long to collect the writes of a controller before sending them. Defaults to 300 milliseconds. */
  commandDelayInMs?: number;
}

/** What the setup page shows about a running device. */
export interface DaikinAccessoryStatus {
  isReachable: boolean;
  lastError?: string;
  state?: DaikinState;
}

/**
 * Tell whether an attribute change came from a Matter controller
 *
 * @param {ActionContext} context The context of the change.
 * @returns {boolean} False for a change this plugin made itself.
 */
function isControllerWrite(context: ActionContext): boolean {
  return context.fabric !== undefined;
}

/**
 * Do nothing: the settled value of a queued task is its caller's business, not the queue's
 *
 * @returns {void}
 */
function ignore(): void {
  // Intentionally empty.
}

/**
 * One Daikin air conditioner and the Matter endpoints that stand for it: a room air conditioner and, when they are
 * exposed, one on/off switch for each axis the unit swings on, for each of the dry and fan modes, for the auto fan speed
 * and for each special mode. The fan control is a fan of its own when it is exposed that way, and a unit that has given
 * its outdoor temperature gets a sensor for it.
 *
 * The endpoints are built in `endpoints.ts`, what the controllers ask for is collected in `pendingCommand.ts` and what
 * the unit answers is written to Matter in `matterState.ts`. This class wires them together: it takes the writes of the
 * controllers, and runs the reads and the commands one after the other.
 */
export class DaikinAccessory implements AccessoryEndpoints {
  readonly name: string;
  readonly endpoint: MatterbridgeEndpoint;
  readonly verticalSwitch: MatterbridgeEndpoint | undefined;
  readonly horizontalSwitch: MatterbridgeEndpoint | undefined;
  readonly dryModeSwitch: MatterbridgeEndpoint | undefined;
  readonly fanModeSwitch: MatterbridgeEndpoint | undefined;
  readonly fanAutoSwitch: MatterbridgeEndpoint | undefined;
  /** The fan, when the fan control is not a part of the air conditioner. */
  readonly fan: MatterbridgeEndpoint | undefined;
  /** The switch of each special mode that is exposed. */
  readonly specialModeSwitches: ReadonlyMap<SpecialMode, MatterbridgeEndpoint>;
  readonly outdoorTemperatureSensor: MatterbridgeEndpoint | undefined;
  /** What the unit accepted when the endpoints were built. */
  readonly capabilities: DaikinCapabilities;
  /** The readings the unit had given when the endpoints were built. */
  readonly reportedSensors: ReportedSensors;

  private config: DaikinDeviceConfig;
  private client: DaikinClient;
  private readonly log: AnsiLogger;
  private readonly commandDelayInMs: number;
  private readonly identity: EndpointIdentity;
  private readonly layout: AccessoryLayout;

  private state: DaikinState | undefined;
  private sensors: DaikinSensors | undefined;
  /** The speed the fan last ran at when it was not on auto, which turning auto off goes back to. */
  private lastManualFanSpeed: FanSpeed | undefined;
  private isReachable = false;
  private lastError: string | undefined;
  private failureCount = 0;
  private isClosed = false;

  // What the controllers asked for since the last command was sent.
  private readonly pending = new PendingCommand();
  private hasPendingCommand = false;
  private commandTimer: NodeJS.Timeout | undefined;
  // Reads and commands run one after the other, so a read never overwrites what a command is about to send.
  private queue: Promise<void> = Promise.resolve();

  /**
   * Create the endpoints of a device from what it accepts and how it is configured
   *
   * @param {DaikinAccessoryOptions} options The device, its capabilities and its client.
   * @throws {Error} When the unit neither cools nor heats, so no Matter thermostat can stand for it.
   */
  constructor(options: DaikinAccessoryOptions) {
    this.config = options.config;
    this.capabilities = options.capabilities;
    this.reportedSensors = options.reportedSensors ?? noReportedSensors;
    this.client = options.client;
    this.log = options.log;
    this.commandDelayInMs = options.commandDelayInMs ?? defaultCommandDelayInMs;
    this.name = options.config.name;
    this.identity = { name: this.name, serial: options.config.macAddress, vendorId: options.vendorId };
    this.layout = getAccessoryLayout(this.config, this.capabilities, this.reportedSensors);

    this.endpoint = this.createAirConditioner();
    if (this.layout.hasSeparateFan) this.fan = createFanEndpoint(this.identity, this.layout);
    if (this.layout.hasFan) this.subscribeFan(this.fan ?? this.endpoint);
    if (this.config.swingControl === 'switches') {
      if (this.capabilities.swingModes.includes('vertical')) this.verticalSwitch = this.createSwingSwitch('vertical');
      if (this.capabilities.swingModes.includes('horizontal')) this.horizontalSwitch = this.createSwingSwitch('horizontal');
    }
    if (this.config.hasDryModeSwitch && this.capabilities.modes.includes('dehumidify')) this.dryModeSwitch = this.createModeSwitch('dehumidify');
    if (this.config.hasFanModeSwitch && this.capabilities.modes.includes('fan')) this.fanModeSwitch = this.createModeSwitch('fan');
    if (this.config.hasFanAutoSwitch && hasFanAuto(this.capabilities)) {
      this.fanAutoSwitch = this.createSwitch('fan-auto', 'A', 'Auto Fan', (isOn) => {
        this.pending.requestFanAuto(isOn);
        this.scheduleCommand(`auto fan ${isOn ? 'on' : 'off'}`);
      });
    }
    const specialModeSwitches = new Map<SpecialMode, MatterbridgeEndpoint>();
    for (const specialMode of getSwitchableSpecialModes(this.capabilities)) {
      if (this.config.specialModeSwitches.includes(specialMode)) specialModeSwitches.set(specialMode, this.createSpecialModeSwitch(specialMode));
    }
    this.specialModeSwitches = specialModeSwitches;
    if (this.layout.hasOutdoorTemperature) this.outdoorTemperatureSensor = createOutdoorTemperatureEndpoint(this.identity);
  }

  /**
   * List the Matter endpoints of the device
   *
   * @returns {MatterbridgeEndpoint[]} The air conditioner, then the fan, the switches and the sensor the device has.
   */
  get endpoints(): MatterbridgeEndpoint[] {
    const switches = [this.verticalSwitch, this.horizontalSwitch, this.dryModeSwitch, this.fanModeSwitch, this.fanAutoSwitch, ...this.specialModeSwitches.values()];
    return [this.endpoint, this.fan, ...switches, this.outdoorTemperatureSensor].filter((endpoint) => endpoint !== undefined);
  }

  /**
   * Tell which readings the unit gives, when the last read gave one the endpoints were not built for
   *
   * @returns {ReportedSensors | undefined} Every reading the unit has given, or undefined when the endpoints show them all.
   */
  getNewlyReportedSensors(): ReportedSensors | undefined {
    if (this.sensors === undefined) return undefined;
    const reported = addReportedSensors(this.reportedSensors, this.sensors);
    return reported === this.reportedSensors ? undefined : reported;
  }

  /**
   * Show no reading until the unit is read
   *
   * A Matter thermostat is created with a room temperature, which is nobody's reading.
   *
   * @returns {Promise<void>} Resolves when the readings of the device have no value.
   */
  async clearReadings(): Promise<void> {
    await applySensors(this, this.layout, { indoorTemperatureInC: null, outdoorTemperatureInC: null, indoorHumidityInPercent: null });
  }

  /**
   * Report how the device is doing
   *
   * @returns {DaikinAccessoryStatus} Whether the last reads succeeded, the last error and the last state read.
   */
  getStatus(): DaikinAccessoryStatus {
    return { isReachable: this.isReachable, lastError: this.lastError, state: this.state };
  }

  /**
   * Switch to a new client after the address or the credentials of the device changed
   *
   * @param {DaikinDeviceConfig} config The updated device.
   * @param {DaikinClient} client The client for the updated device.
   * @returns {Promise<void>} Resolves when the previous client is closed.
   */
  async updateConnection(config: DaikinDeviceConfig, client: DaikinClient): Promise<void> {
    const previous = this.client;
    this.config = config;
    this.client = client;
    await this.closeClient(previous);
  }

  /**
   * Replace the settings that change no endpoint: the fixed fan speed and swing mode of a hidden control
   *
   * @param {DaikinDeviceConfig} config The updated device.
   * @returns {void}
   */
  updateConfig(config: DaikinDeviceConfig): void {
    this.config = config;
  }

  /**
   * Ask the unit what it accepts now, in turn with the reads and the commands
   *
   * @returns {Promise<DaikinCapabilities>} What the unit accepts.
   * @throws {DaikinError} When the unit does not answer.
   */
  async readCapabilities(): Promise<DaikinCapabilities> {
    return this.enqueue(async () => this.client.getCapabilities());
  }

  /**
   * Read the state and the sensors of the unit and write them to the Matter endpoints
   *
   * A read that fails is logged, never thrown: after two failures in a row the endpoints are reported as unreachable.
   *
   * @returns {Promise<boolean>} True when the unit answered.
   */
  async refresh(): Promise<boolean> {
    return this.enqueue(async () => this.readAndApply(true));
  }

  /**
   * Send what the controllers asked for now, without waiting for the command delay
   *
   * @returns {Promise<void>} Resolves when the command is sent and the state is read back, or when there was nothing to send.
   */
  async flushCommands(): Promise<void> {
    clearTimeout(this.commandTimer);
    this.commandTimer = undefined;
    await this.enqueue(async () => this.sendPendingCommand());
  }

  /**
   * Stop the device: drop what is waiting to be sent and close the connection to the adapter
   *
   * @returns {Promise<void>} Resolves when the running read or command is done and the client is closed.
   */
  async close(): Promise<void> {
    this.isClosed = true;
    clearTimeout(this.commandTimer);
    this.commandTimer = undefined;
    this.hasPendingCommand = false;
    await this.queue;
    await this.closeClient(this.client);
  }

  private createAirConditioner(): MatterbridgeEndpoint {
    const endpoint = createAirConditionerEndpoint(this.identity, this.layout);
    const { profile } = this.layout;
    endpoint.subscribeAttribute(OnOff, 'onOff', (isOn: boolean, _wasOn: boolean, context: ActionContext) => {
      if (isControllerWrite(context)) this.queueControl({ power: isOn }, `power ${isOn ? 'on' : 'off'}`);
    });
    endpoint.subscribeAttribute(Thermostat, 'systemMode', (systemMode: Thermostat.SystemMode, _previous: Thermostat.SystemMode, context: ActionContext) => {
      if (isControllerWrite(context)) this.handleSystemMode(systemMode);
    });
    if (profile !== 'heat') {
      endpoint.subscribeAttribute(Thermostat, 'occupiedCoolingSetpoint', (setpoint: number, _previous: number, context: ActionContext) => {
        if (isControllerWrite(context)) this.queueSetpoint('cool', setpoint);
      });
    }
    if (profile !== 'cool') {
      endpoint.subscribeAttribute(Thermostat, 'occupiedHeatingSetpoint', (setpoint: number, _previous: number, context: ActionContext) => {
        if (isControllerWrite(context)) this.queueSetpoint('heat', setpoint);
      });
    }
    return endpoint;
  }

  private subscribeFan(endpoint: MatterbridgeEndpoint): void {
    const onFanWrite = (_value: unknown, _previous: unknown, context: ActionContext): void => {
      if (isControllerWrite(context)) this.queueFan();
    };
    endpoint.subscribeAttribute(FanControl, 'fanMode', onFanWrite);
    endpoint.subscribeAttribute(FanControl, 'percentSetting', onFanWrite);
  }

  // The code tells the switches of one device apart in their serial numbers.
  private createSwitch(key: string, code: string, label: string, onWrite: (isOn: boolean) => void): MatterbridgeEndpoint {
    const endpoint = createSwitchEndpoint(this.identity, key, code, label);
    endpoint.subscribeAttribute(OnOff, 'onOff', (isOn: boolean, _wasOn: boolean, context: ActionContext) => {
      if (isControllerWrite(context)) onWrite(isOn);
    });
    return endpoint;
  }

  private createSwingSwitch(axis: SwingAxis): MatterbridgeEndpoint {
    const isVertical = axis === 'vertical';
    return this.createSwitch(`${axis}-swing`, isVertical ? 'V' : 'H', isVertical ? 'Vertical Swing' : 'Horizontal Swing', (isOn) => {
      this.pending.requestSwing(axis, isOn);
      this.scheduleCommand(`${axis} swing ${isOn ? 'on' : 'off'}`);
    });
  }

  private createModeSwitch(mode: SwitchedMode): MatterbridgeEndpoint {
    const isDry = mode === 'dehumidify';
    return this.createSwitch(isDry ? 'dry-mode' : 'fan-mode', isDry ? 'D' : 'F', isDry ? 'Dry Mode' : 'Fan Mode', (isOn) => this.handleModeSwitch(mode, isOn));
  }

  private createSpecialModeSwitch(specialMode: SpecialMode): MatterbridgeEndpoint {
    const label = specialModeLabels[specialMode];
    return this.createSwitch(specialMode, label.charAt(0), label, (isOn) => {
      this.pending.requestSpecialMode(specialMode, isOn);
      this.scheduleCommand(`${label} ${isOn ? 'on' : 'off'}`);
    });
  }

  private handleModeSwitch(mode: SwitchedMode, isOn: boolean): void {
    if (isOn) {
      this.queueControl({ power: true, mode }, `${mode} mode switch on`);
      return;
    }
    // Leaving the mode goes back to cooling, or to heating on a unit that only heats. A switch turned off after the
    // unit already left the mode sends nothing: the read that follows shows where the unit is.
    const isInMode = (this.pending.mode ?? this.state?.mode) === mode;
    if (isInMode) this.queueControl({ mode: this.layout.profile === 'heat' ? 'heat' : 'cool' }, `${mode} mode switch off`);
    else this.scheduleCommand(`${mode} mode switch off`);
  }

  private handleSystemMode(systemMode: Thermostat.SystemMode): void {
    if (systemMode === Thermostat.SystemMode.Off) {
      this.queueControl({ power: false }, 'mode off');
      return;
    }
    const mode = toOperatingMode(systemMode, this.capabilities.modes);
    if (mode === undefined) {
      this.log.warn(`"${this.name}" has no mode for the Matter system mode ${Thermostat.SystemMode[systemMode]}: the request is ignored`);
      // Nothing is sent, but the read that follows puts the unit's own mode back.
      this.scheduleCommand('a mode it does not have');
      return;
    }
    this.queueControl({ power: true, mode }, `mode ${mode}`);
  }

  private queueControl(control: DaikinControl, description: string): void {
    this.pending.requestControl(control);
    this.scheduleCommand(description);
  }

  private queueSetpoint(kind: SetpointKind, setpoint: number): void {
    this.pending.requestSetpoint(kind, setpoint / 100);
    this.scheduleCommand(`${kind} setpoint ${setpoint / 100} °C`);
  }

  private queueFan(): void {
    this.pending.requestFanSpeed();
    this.scheduleCommand('fan speed');
  }

  private scheduleCommand(description: string): void {
    if (this.isClosed) return;
    this.log.info(`"${this.name}" received ${description}`);
    this.hasPendingCommand = true;
    clearTimeout(this.commandTimer);
    this.commandTimer = setTimeout(() => {
      this.commandTimer = undefined;
      void this.enqueue(async () => this.sendPendingCommand());
    }, this.commandDelayInMs);
  }

  private async enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.then(ignore, ignore);
    return result;
  }

  // A special mode takes a request of its own, so it is sent after the state, one request for each.
  private async sendSpecialModes(changes: Partial<Record<SpecialMode, boolean>>, mode: DaikinState['mode'] | undefined): Promise<void> {
    for (const specialMode of SPECIAL_MODES) {
      const isOn = changes[specialMode];
      if (isOn === undefined) continue;
      if (isOn && (mode === undefined || !this.capabilities.specialModes[mode].includes(specialMode))) {
        this.log.warn(`"${this.name}" does not take ${specialModeLabels[specialMode]} in ${mode ?? 'its current'} mode: the request is ignored`);
        continue;
      }
      const action = `${specialModeLabels[specialMode]} ${isOn ? 'on' : 'off'}`;
      try {
        await this.client.setSpecialMode(specialMode, isOn);
        this.log.info(`"${this.name}" turned ${action}`);
      } catch (error) {
        this.log.error(`"${this.name}" did not turn ${action}: ${getErrorMessage(error)}`);
      }
    }
  }

  private async sendPendingCommand(): Promise<void> {
    if (!this.hasPendingCommand) return;
    this.hasPendingCommand = false;
    const unit = { state: this.state, capabilities: this.capabilities, fanSteps: this.layout.fanSteps, lastManualFanSpeed: this.lastManualFanSpeed };
    const { control, specialModes } = this.pending.take(unit, () => readFanSpeed(this.fan ?? this.endpoint, this.layout.fanSteps));
    const mode = control.mode ?? this.state?.mode;
    if (Object.keys(control).length > 0) {
      addHiddenSettings(control, this.config, this.capabilities);
      try {
        await this.client.setState(control);
        this.log.info(`"${this.name}" set to ${JSON.stringify(control)}`);
      } catch (error) {
        this.log.error(`"${this.name}" did not take ${JSON.stringify(control)}: ${getErrorMessage(error)}`);
      }
    }
    await this.sendSpecialModes(specialModes, mode);
    // Read back what the unit holds, which also undoes a request it did not take. The readings of the last poll are
    // recent enough to go with it.
    await this.readAndApply(false);
  }

  private async readAndApply(shouldReadSensors: boolean): Promise<boolean> {
    if (this.isClosed) return false;
    let state: DaikinState;
    let sensors = this.sensors;
    try {
      if (shouldReadSensors || sensors === undefined) ({ state, sensors } = await this.client.getStateAndSensors());
      else state = await this.client.getState();
    } catch (error) {
      await this.handleReadFailure(error);
      return false;
    }
    this.state = state;
    this.sensors = sensors;
    if (state.fanSpeed !== 'auto') this.lastManualFanSpeed = state.fanSpeed;
    this.failureCount = 0;
    this.lastError = undefined;
    // A controller wrote while the unit was answering: the command about to be sent reads these attributes.
    if (this.hasPendingCommand || this.isClosed) return true;
    try {
      await this.setReachable(true);
      await applyState(this, this.layout, state, sensors);
    } catch (error) {
      this.log.warn(`"${this.name}" state could not be written to Matter: ${getErrorMessage(error)}`);
    }
    return true;
  }

  private async handleReadFailure(error: unknown): Promise<void> {
    this.failureCount += 1;
    this.lastError = getErrorMessage(error);
    this.log.debug(`"${this.name}" did not answer (${this.failureCount} in a row): ${this.lastError}`);
    if (this.failureCount !== unreachableAfterFailures) return;
    this.log.warn(`"${this.name}" is unreachable at ${this.config.host}: ${this.lastError}`);
    try {
      await this.setReachable(false);
    } catch (reachableError) {
      this.log.debug(`"${this.name}" reachability could not be written to Matter: ${getErrorMessage(reachableError)}`);
    }
  }

  private async setReachable(isReachable: boolean): Promise<void> {
    if (this.isReachable !== isReachable) this.log.notice(`"${this.name}" is ${isReachable ? 'reachable' : 'unreachable'}`);
    this.isReachable = isReachable;
    for (const endpoint of this.endpoints) {
      const hasChanged = await endpoint.updateAttribute(BridgedDeviceBasicInformation, 'reachable', isReachable);
      if (hasChanged) await endpoint.triggerEvent(BridgedDeviceBasicInformation, 'reachableChanged', { reachableNewValue: isReachable });
    }
  }

  private async closeClient(client: DaikinClient): Promise<void> {
    try {
      await client.close();
    } catch (error) {
      this.log.debug(`"${this.name}" connection did not close cleanly: ${getErrorMessage(error)}`);
    }
  }
}
