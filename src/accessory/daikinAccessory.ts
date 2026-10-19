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
import { type ActionContext, Node } from 'matterbridge/matter';
import { BridgedDeviceBasicInformation, FanControl, ModeSelect, OnOff, Thermostat } from 'matterbridge/matter/clusters';

import { type DaikinDeviceConfig, SWITCHED_MODES, type SwitchedMode } from '../config.js';
import { addReportedSensors, getSwitchableSpecialModes, noReportedSensors, type ReportedSensors } from '../controls.js';
import { getErrorMessage } from '../errors.js';
import { modeSelectChoices, type SelectChoices, swingSelectChoices, toModeOptions, toOperatingMode } from '../mapping.js';
import {
  createAirConditionerEndpoint,
  createFanEndpoint,
  createHumidityEndpoint,
  createModeSelectEndpoint,
  createOutdoorTemperatureEndpoint,
  createSwitchEndpoint,
  type EndpointIdentity,
} from './endpoints.js';
import { type AccessoryLayout, getAccessoryLayout } from './layout.js';
import { type AccessoryEndpoints, applySensors, applyState, readFanSpeed } from './matterState.js';
import { addHiddenSettings, PendingCommand, type SetpointKind, type SwingAxis } from './pendingCommand.js';

/** How long, in milliseconds, the writes of a controller are collected before they are sent as one command. */
export const defaultCommandDelayInMs = 300;

/** How many reads in a row have to fail before the device is reported as unreachable. */
const unreachableAfterFailures = 2;

/**
 * What tells the switch of each mode apart, and what it is called in Matter. The first letters of Auto and Heat are
 * taken by the auto fan switch and the horizontal swing switch.
 */
const modeSwitchNames: Readonly<Record<SwitchedMode, { key: string; code: string; label: string }>> = {
  auto: { key: 'auto-mode', code: 'U', label: 'Auto Mode' },
  cool: { key: 'cool-mode', code: 'C', label: 'Cool Mode' },
  heat: { key: 'heat-mode', code: 'T', label: 'Heat Mode' },
  dehumidify: { key: 'dry-mode', code: 'D', label: 'Dry Mode' },
  fan: { key: 'fan-mode', code: 'F', label: 'Fan Mode' },
};

/** What each special mode is called in Matter and in the log: Daikin's own names. */
const specialModeLabels: Readonly<Record<SpecialMode, string>> = { powerful: 'Powerful', econo: 'Econo', streamer: 'Streamer' };

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
 * One Daikin air conditioner and the Matter endpoints that stand for it: a room air conditioner, with a fan control
 * whose rocking is the swing when the swing is exposed as native rocking, and, when they are exposed, one on/off switch for
 * each axis the unit swings on, for each mode, for the auto fan speed and for each special mode, and a mode select for
 * the mode and one for the swing. The fan control is a fan of its own when it is exposed that way. The humidity of a
 * unit that has given it is on the air conditioner, and on a sensor of its own too when one is asked for. A unit that has given its outdoor temperature gets a sensor for it, unless none is
 * asked for. The fan, the switches, the mode selects and the humidity sensor are each a device of their own in Matter, or parts of the air
 * conditioner when the device is exposed as a composed one. The outdoor temperature sensor is always a device of its own.
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
  /** The switch of each mode that is exposed. */
  readonly modeSwitches: ReadonlyMap<SwitchedMode, MatterbridgeEndpoint>;
  readonly fanAutoSwitch: MatterbridgeEndpoint | undefined;
  /** The fan, when the fan control is not a part of the air conditioner. */
  readonly fan: MatterbridgeEndpoint | undefined;
  /** The switch of each special mode that is exposed. */
  readonly specialModeSwitches: ReadonlyMap<SpecialMode, MatterbridgeEndpoint>;
  readonly modeSelect: MatterbridgeEndpoint | undefined;
  readonly swingSelect: MatterbridgeEndpoint | undefined;
  /** The humidity sensor, when the humidity is on a sensor of its own besides the air conditioner. */
  readonly humiditySensor: MatterbridgeEndpoint | undefined;
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
  /** The air conditioner, when the other endpoints of the device are its parts. */
  private readonly parent: MatterbridgeEndpoint | undefined;

  private state: DaikinState | undefined;
  private sensors: DaikinSensors | undefined;
  /** The speed the fan last ran at when it was not on auto, which turning auto off goes back to. */
  private lastManualFanSpeed: FanSpeed | undefined;
  private isReachable = false;
  private lastError: string | undefined;
  private failureCount = 0;
  private isDisposed = false;

  // What the controllers asked for since the last command was sent.
  private readonly pending = new PendingCommand();
  // What the setpoints showed before the controllers wrote them since the last command, in the Matter encoding.
  private setpointsBefore: Partial<Record<SetpointKind, number>> = {};
  private hasPendingCommand = false;
  private commandTimer: NodeJS.Timeout | undefined;
  // Reads and commands run one after the other, so a read never overwrites what a command is about to send.
  private queue: Promise<void> = Promise.resolve();
  // What is subscribed on each endpoint, to subscribe it again after a factory reset of the Matter node.
  private readonly subscriptions = new Map<MatterbridgeEndpoint, (() => void)[]>();
  // Whether a read waits for the node to come back online after a factory reset.
  private isAwaitingOnline = false;

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
    if (this.layout.isComposed) this.parent = this.endpoint;
    if (this.layout.hasSeparateFan) this.fan = this.createFan();
    if (this.layout.hasFan) this.subscribeFan(this.fan ?? this.endpoint);
    if (this.layout.hasSwingSwitches) {
      if (this.capabilities.swingModes.includes('vertical')) this.verticalSwitch = this.createSwingSwitch('vertical');
      if (this.capabilities.swingModes.includes('horizontal')) this.horizontalSwitch = this.createSwingSwitch('horizontal');
    }
    const modeSwitches = new Map<SwitchedMode, MatterbridgeEndpoint>();
    for (const mode of SWITCHED_MODES) {
      const hasModeSwitch = this.config.modeControl === 'switches' && this.config.modeSwitches.includes(mode) && this.capabilities.modes.includes(mode);
      if (hasModeSwitch) modeSwitches.set(mode, this.createModeSwitch(mode));
    }
    this.modeSwitches = modeSwitches;
    if (this.layout.hasFanAutoSwitch) {
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
    if (this.layout.modeSelectModes.length > 0) {
      // Picking a mode turns the unit on in it, as the system mode of the thermostat does.
      this.modeSelect = this.createSelect('mode-select', 'M', 'Mode', modeSelectChoices, this.layout.modeSelectModes, (mode) =>
        this.queueControl(mode === 'off' ? { power: false } : { power: true, mode }, `mode select ${mode}`),
      );
    }
    if (this.layout.swingSelectModes.length > 0) {
      this.swingSelect = this.createSelect('swing-select', 'W', 'Swing', swingSelectChoices, this.layout.swingSelectModes, (swingMode) =>
        this.queueControl({ swingMode }, `swing select ${swingMode}`),
      );
    }
    if (this.layout.hasSeparateHumiditySensor) this.humiditySensor = createHumidityEndpoint(this.identity, this.parent);
    if (this.layout.hasOutdoorTemperature) this.outdoorTemperatureSensor = createOutdoorTemperatureEndpoint(this.identity);
  }

  /**
   * List the Matter endpoints of the device that are devices in Matter: the ones to register, which each say whether
   * the unit is reachable
   *
   * @returns {MatterbridgeEndpoint[]} The air conditioner, then the fan, the switches and the sensors the device has, unless they are parts of the air conditioner, which the outdoor temperature sensor never is.
   */
  get endpoints(): MatterbridgeEndpoint[] {
    if (this.parent !== undefined) return [this.parent, this.outdoorTemperatureSensor].filter((endpoint) => endpoint !== undefined);
    const switches = [this.verticalSwitch, this.horizontalSwitch, ...this.modeSwitches.values(), this.fanAutoSwitch, ...this.specialModeSwitches.values()];
    return [this.endpoint, this.fan, ...switches, this.modeSelect, this.swingSelect, this.humiditySensor, this.outdoorTemperatureSensor].filter(
      (endpoint) => endpoint !== undefined,
    );
  }

  /**
   * Tell which readings the unit gives, when the last read gave one the endpoints were not built for
   *
   * An outdoor temperature no sensor is asked for is left out: there is nothing to build for it. It counts from the
   * first read after its sensor is asked for.
   *
   * @returns {ReportedSensors | undefined} Every reading the unit has given, or undefined when the endpoints show them all.
   */
  getNewlyReportedSensors(): ReportedSensors | undefined {
    if (this.sensors === undefined) return undefined;
    const sensors = this.config.hasOutdoorTemperatureSensor ? this.sensors : { ...this.sensors, outdoorTemperatureInC: null };
    const reported = addReportedSensors(this.reportedSensors, sensors);
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
   * @returns {Promise<void>} Resolves when the previous client is disposed.
   */
  async updateConnection(config: DaikinDeviceConfig, client: DaikinClient): Promise<void> {
    const previous = this.client;
    this.config = config;
    this.client = client;
    await this.disposeClient(previous);
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
   * Stop the device for good: drop what is waiting to be sent and close the connection to the adapter. The device
   * reads and sends nothing afterwards, so a device that is needed again is built anew.
   *
   * @returns {Promise<void>} Resolves when the running read or command is done and the client is disposed.
   */
  async dispose(): Promise<void> {
    this.isDisposed = true;
    clearTimeout(this.commandTimer);
    this.commandTimer = undefined;
    this.hasPendingCommand = false;
    await this.queue;
    await this.disposeClient(this.client);
  }

  private createAirConditioner(): MatterbridgeEndpoint {
    const endpoint = createAirConditionerEndpoint(this.identity, this.layout);
    const { profile } = this.layout;
    this.listen(endpoint, () =>
      endpoint.subscribeAttribute(OnOff, 'onOff', (isOn: boolean, _wasOn: boolean, context: ActionContext) => {
        if (isControllerWrite(context)) this.queueControl({ power: isOn }, `power ${isOn ? 'on' : 'off'}`);
      }),
    );
    this.listen(endpoint, () =>
      endpoint.subscribeAttribute(Thermostat, 'systemMode', (systemMode: Thermostat.SystemMode, _previous: Thermostat.SystemMode, context: ActionContext) => {
        if (isControllerWrite(context)) this.handleSystemMode(systemMode);
      }),
    );
    if (profile !== 'heat') {
      this.listen(endpoint, () =>
        endpoint.subscribeAttribute(Thermostat, 'occupiedCoolingSetpoint', (setpoint: number, previous: number, context: ActionContext) => {
          if (isControllerWrite(context)) this.queueSetpoint('cool', setpoint, previous);
        }),
      );
    }
    if (profile !== 'cool') {
      this.listen(endpoint, () =>
        endpoint.subscribeAttribute(Thermostat, 'occupiedHeatingSetpoint', (setpoint: number, previous: number, context: ActionContext) => {
          if (isControllerWrite(context)) this.queueSetpoint('heat', setpoint, previous);
        }),
      );
    }
    return endpoint;
  }

  // The fan of a unit runs only while the unit is on, so its on/off is the power of the air conditioner.
  private createFan(): MatterbridgeEndpoint {
    const endpoint = createFanEndpoint(this.identity, this.layout, this.parent);
    this.listen(endpoint, () =>
      endpoint.subscribeAttribute(OnOff, 'onOff', (isOn: boolean, _wasOn: boolean, context: ActionContext) => {
        if (isControllerWrite(context)) this.queueControl({ power: isOn }, `fan power ${isOn ? 'on' : 'off'}`);
      }),
    );
    return endpoint;
  }

  /**
   * Subscribe to an attribute of an endpoint, and again whenever the endpoint comes back from a factory reset
   *
   * Matter resets the node to factory defaults when its last fabric leaves, such as when the bridge is removed from the
   * last app it was in. The reset drops what was subscribed on each endpoint, so that the writes of the next app it is
   * paired with would reach nothing.
   *
   * @param {MatterbridgeEndpoint} endpoint The endpoint.
   * @param {() => void} subscribe Subscribes to the attribute, now and after each reset.
   * @returns {void}
   */
  private listen(endpoint: MatterbridgeEndpoint, subscribe: () => void): void {
    subscribe();
    const known = this.subscriptions.get(endpoint);
    if (known !== undefined) {
      known.push(subscribe);
      return;
    }
    const subscriptions = [subscribe];
    this.subscriptions.set(endpoint, subscriptions);
    let wasReset = false;
    endpoint.lifecycle.reset.on(() => {
      wasReset = true;
    });
    endpoint.lifecycle.ready.on(() => {
      if (!wasReset) return;
      wasReset = false;
      for (const again of subscriptions) again();
      if (endpoint === this.endpoint) this.log.info(`"${this.name}" is subscribed again after the Matter node was reset`);
      this.refreshWhenOnline(endpoint);
    });
  }

  /**
   * Write the state of the unit to Matter once the node is back online after a factory reset
   *
   * The reset put every attribute back to its default, and the endpoints come back one by one while the node is offline.
   * As the node goes online, the thermostat writes its temperature in a way that cannot wait for a write of the plugin,
   * and the reset fails when one holds the thermostat then. One read, once every endpoint is back, replaces the defaults.
   *
   * @param {MatterbridgeEndpoint} endpoint An endpoint of the device that came back.
   * @returns {void}
   */
  private refreshWhenOnline(endpoint: MatterbridgeEndpoint): void {
    if (this.isAwaitingOnline) return;
    this.isAwaitingOnline = true;
    // The read is not awaited, so that the node goes online without waiting for the unit. It does nothing once the
    // device is disposed.
    Node.forEndpoint(endpoint).lifecycle.online.once(() => {
      this.isAwaitingOnline = false;
      void this.refresh();
    });
  }

  private subscribeFan(endpoint: MatterbridgeEndpoint): void {
    const onFanWrite = (_value: unknown, _previous: unknown, context: ActionContext): void => {
      if (isControllerWrite(context)) this.queueFan();
    };
    this.listen(endpoint, () => endpoint.subscribeAttribute(FanControl, 'fanMode', onFanWrite));
    this.listen(endpoint, () => endpoint.subscribeAttribute(FanControl, 'percentSetting', onFanWrite));
    const { vertical, horizontal } = this.layout.rockAxes;
    if (!vertical && !horizontal) return;
    this.listen(endpoint, () =>
      endpoint.subscribeAttribute('FanControl', 'rockSetting', (setting: { rockUpDown?: boolean; rockLeftRight?: boolean }, _previous: unknown, context: ActionContext) => {
        if (!isControllerWrite(context)) return;
        if (vertical) this.pending.requestSwing('vertical', setting.rockUpDown === true);
        if (horizontal) this.pending.requestSwing('horizontal', setting.rockLeftRight === true);
        this.scheduleCommand(`rocking ${JSON.stringify({ vertical: setting.rockUpDown === true, horizontal: setting.rockLeftRight === true })}`);
      }),
    );
  }

  // The code tells the switches of one device apart in their serial numbers.
  private createSwitch(key: string, code: string, label: string, onWrite: (isOn: boolean) => void): MatterbridgeEndpoint {
    const endpoint = createSwitchEndpoint(this.identity, key, code, label, this.parent);
    this.listen(endpoint, () =>
      endpoint.subscribeAttribute(OnOff, 'onOff', (isOn: boolean, _wasOn: boolean, context: ActionContext) => {
        if (isControllerWrite(context)) onWrite(isOn);
      }),
    );
    return endpoint;
  }

  // Matter refuses a mode the select does not list, so a controller only ever picks one the unit takes.
  private createSelect<T extends string>(
    key: string,
    code: string,
    label: string,
    choices: SelectChoices<T>,
    supported: readonly T[],
    onPick: (value: T) => void,
  ): MatterbridgeEndpoint {
    const endpoint = createModeSelectEndpoint(this.identity, key, code, label, toModeOptions(choices, supported), this.parent);
    this.listen(endpoint, () =>
      endpoint.subscribeAttribute(ModeSelect, 'currentMode', (mode: number, _previous: number, context: ActionContext) => {
        if (isControllerWrite(context)) onPick(choices.values[mode]);
      }),
    );
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
    const { key, code, label } = modeSwitchNames[mode];
    return this.createSwitch(key, code, label, (isOn) => this.handleModeSwitch(mode, isOn));
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
    // A switch turned off after the unit already left the mode sends nothing: the read that follows shows where the unit is.
    const isInMode = (this.pending.mode ?? this.state?.mode) === mode;
    if (!isInMode) this.scheduleCommand(`${mode} mode switch off`);
    // Leaving dry or fan goes back to cooling, or to heating on a unit that only heats: the unit's own modes, whatever
    // a replacement gives the thermostat. Leaving any other mode turns the unit off, as there is no mode to go back to.
    else if (mode === 'dehumidify' || mode === 'fan') this.queueControl({ mode: this.capabilities.modes.includes('cool') ? 'cool' : 'heat' }, `${mode} mode switch off`);
    else this.queueControl({ power: false }, `${mode} mode switch off`);
  }

  private handleSystemMode(systemMode: Thermostat.SystemMode): void {
    if (systemMode === Thermostat.SystemMode.Off) {
      this.queueControl({ power: false }, 'mode off');
      return;
    }
    const mode = toOperatingMode(systemMode, this.capabilities.modes, this.layout.modeReplacements);
    if (mode === undefined) {
      this.log.warn(`"${this.name}" has no mode for the Matter system mode ${Thermostat.SystemMode[systemMode]}: the request is ignored`);
      // Nothing is sent, but the read that follows puts the unit's own mode back.
      this.scheduleCommand('a mode it does not have');
      return;
    }
    this.queueControl({ power: true, mode }, `mode ${mode} for the Matter system mode ${Thermostat.SystemMode[systemMode]}`);
  }

  private queueControl(control: DaikinControl, description: string): void {
    this.pending.requestControl(control);
    this.scheduleCommand(description);
  }

  private queueSetpoint(kind: SetpointKind, setpoint: number, previous: number): void {
    // The first write since the last command holds what the setpoint showed before any of them.
    this.setpointsBefore[kind] ??= previous;
    this.pending.requestSetpoint(kind, setpoint / 100);
    this.scheduleCommand(`${kind} setpoint ${setpoint / 100} °C`);
  }

  private queueFan(): void {
    this.pending.requestFanSpeed();
    this.scheduleCommand('fan speed');
  }

  private scheduleCommand(description: string): void {
    if (this.isDisposed) return;
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
    const setpointsBefore = this.setpointsBefore;
    this.setpointsBefore = {};
    const unit = {
      state: this.state,
      capabilities: this.capabilities,
      fanSteps: this.layout.fanSteps,
      lastManualFanSpeed: this.lastManualFanSpeed,
      modeReplacements: this.layout.modeReplacements,
    };
    const { control, specialModes } = this.pending.take(unit, () => readFanSpeed(this.fan ?? this.endpoint, this.layout.fanPositions));
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
    await this.readAndApply(false, setpointsBefore);
  }

  /**
   * Read the unit and write what it holds to Matter
   *
   * @param {boolean} shouldReadSensors Whether to read the sensors too, instead of keeping the readings of the last poll.
   * @param {Partial<Record<SetpointKind, number>>} [setpointsBefore] What the setpoints showed before the command just sent, which are put back while the unit is in a mode that takes none.
   * @returns {Promise<boolean>} True when the unit answered.
   */
  private async readAndApply(shouldReadSensors: boolean, setpointsBefore: Partial<Record<SetpointKind, number>> = {}): Promise<boolean> {
    if (this.isDisposed) return false;
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
    if (this.hasPendingCommand || this.isDisposed) return true;
    try {
      await this.setReachable(true);
      await applyState(this, this.layout, state, sensors);
      // Dry and fan take no setpoint, so a setpoint a controller wrote in them would stay at what it wrote.
      if (state.mode === 'dehumidify' || state.mode === 'fan') await this.restoreSetpoints(setpointsBefore);
    } catch (error) {
      this.log.warn(`"${this.name}" state could not be written to Matter: ${getErrorMessage(error)}`);
    }
    return true;
  }

  private async restoreSetpoints(setpoints: Partial<Record<SetpointKind, number>>): Promise<void> {
    if (setpoints.cool !== undefined) await this.endpoint.updateAttribute(Thermostat, 'occupiedCoolingSetpoint', setpoints.cool);
    if (setpoints.heat !== undefined) await this.endpoint.updateAttribute(Thermostat, 'occupiedHeatingSetpoint', setpoints.heat);
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

  private async disposeClient(client: DaikinClient): Promise<void> {
    try {
      await client.dispose();
    } catch (error) {
      this.log.debug(`"${this.name}" connection did not close cleanly: ${getErrorMessage(error)}`);
    }
  }
}
