/**
 * @file src/accessory/pendingCommand.ts
 * @description This file contains what the Matter controllers asked of one air conditioner since the last command was sent.
 * @author Calvin Che
 * @created 2026-10-13
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

import type { DaikinCapabilities, DaikinControl, DaikinState, FanSpeed, OperatingMode, SpecialMode } from 'daikin-local-control';

import { type DaikinDeviceConfig, KEEP_SETTING, type ModeReplacements } from '../config.js';
import { clampTemperature, getTemperatureRange, resolveSwingMode, type SwingChange } from '../mapping.js';

export type SwingAxis = keyof SwingChange;

export type SetpointKind = 'cool' | 'heat';

/** The unit as it was last read, which a command is worked out against. */
export interface UnitSnapshot {
  /** The last state read, or undefined when the unit never answered. */
  state: DaikinState | undefined;
  capabilities: DaikinCapabilities;
  /** The fan speeds a controller can pick, slowest first, without `auto`. */
  fanSteps: readonly FanSpeed[];
  /** The speed the fan last ran at when it was not on auto, which turning auto off goes back to. */
  lastManualFanSpeed: FanSpeed | undefined;
  /** The thermostat mode each mode of the unit is shown as, whose setpoints it takes. */
  modeReplacements: ModeReplacements;
}

/** What a command sends: one change of state, then one request for each special mode. */
export interface CommandRequests {
  control: DaikinControl;
  specialModes: Partial<Record<SpecialMode, boolean>>;
}

/**
 * Add the fixed fan speed and swing mode of the controls that are hidden, which go with every command
 *
 * @param {DaikinControl} control The command, which is changed in place.
 * @param {DaikinDeviceConfig} config The device.
 * @param {DaikinCapabilities} capabilities What its unit accepts: a fixed setting the unit does not take is left out.
 * @returns {void}
 */
export function addHiddenSettings(control: DaikinControl, config: DaikinDeviceConfig, capabilities: DaikinCapabilities): void {
  const { fanControl, fanSpeedWhenHidden, swingControl, swingModeWhenHidden } = config;
  if (fanControl === 'hidden' && fanSpeedWhenHidden !== KEEP_SETTING && capabilities.fanSpeeds.includes(fanSpeedWhenHidden)) {
    control.fanSpeed = fanSpeedWhenHidden;
  }
  if (swingControl === 'hidden' && swingModeWhenHidden !== KEEP_SETTING && capabilities.swingModes.includes(swingModeWhenHidden)) {
    control.swingMode = swingModeWhenHidden;
  }
}

/**
 * What the controllers asked for since the last command was sent
 *
 * A controller writes one attribute at a time, so its writes are collected here and sent as one command.
 */
export class PendingCommand {
  private control: DaikinControl = {};
  private setpoints: Partial<Record<SetpointKind, number>> = {};
  private swing: SwingChange = {};
  private specialModes: Partial<Record<SpecialMode, boolean>> = {};
  private fanAuto: boolean | undefined;
  private isFanSpeedRequested = false;

  /**
   * Get the mode a controller asked for
   *
   * @returns {OperatingMode | undefined} The mode, or undefined when none was asked for.
   */
  get mode(): OperatingMode | undefined {
    return this.control.mode;
  }

  /**
   * Ask for settings of the unit
   *
   * @param {DaikinControl} control The settings. Each one replaces what was asked for that setting before.
   * @returns {void}
   */
  requestControl(control: DaikinControl): void {
    Object.assign(this.control, control);
  }

  /**
   * Ask for one of Matter's two setpoints
   *
   * @param {SetpointKind} kind The cooling or the heating setpoint.
   * @param {number} temperatureInC The setpoint in °C.
   * @returns {void}
   */
  requestSetpoint(kind: SetpointKind, temperatureInC: number): void {
    this.setpoints[kind] = temperatureInC;
  }

  /**
   * Ask for the louvers to swing, or to keep still, on one axis
   *
   * @param {SwingAxis} axis The axis.
   * @param {boolean} isOn Whether the louvers swing on it.
   * @returns {void}
   */
  requestSwing(axis: SwingAxis, isOn: boolean): void {
    this.swing[axis] = isOn;
  }

  /**
   * Ask for a special mode to be turned on or off
   *
   * @param {SpecialMode} specialMode The special mode.
   * @param {boolean} isOn Whether it is on.
   * @returns {void}
   */
  requestSpecialMode(specialMode: SpecialMode, isOn: boolean): void {
    this.specialModes[specialMode] = isOn;
  }

  /**
   * Ask for the auto fan speed, or for the fan to leave it
   *
   * @param {boolean} isOn Whether the fan is on auto.
   * @returns {void}
   */
  requestFanAuto(isOn: boolean): void {
    this.fanAuto = isOn;
  }

  /**
   * Ask for the fan speed the fan control holds when the command is sent
   *
   * @returns {void}
   */
  requestFanSpeed(): void {
    this.isFanSpeedRequested = true;
  }

  /**
   * Take what was asked for, as the command to send, and start collecting again
   *
   * Edge cases:
   *  - a setpoint is clamped to the range of the mode the unit will be in
   *  - auto fan off goes back to the speed the fan last ran at, or to a middle speed when it was never seen off auto
   *  - a fan speed asked for with the unit turned off is left out, so that the unit keeps the speed it holds
   *
   * @param {UnitSnapshot} unit The unit as it was last read.
   * @param {() => FanSpeed | undefined} readFanSpeed Reads the fan speed the fan control holds. It is only called when a fan speed was asked for.
   * @returns {CommandRequests} The change of state, which is empty when nothing was asked of the state, and the special modes to turn on or off.
   */
  take(unit: UnitSnapshot, readFanSpeed: () => FanSpeed | undefined): CommandRequests {
    const { control, specialModes } = this;
    const mode = control.mode ?? unit.state?.mode;
    const target = this.resolveSetpoint(mode, unit);
    if (mode !== undefined && target !== undefined) control.targetTemperatureInC = clampTemperature(target, getTemperatureRange(unit.capabilities, mode));
    // An app turns a fan off by setting it to off or 0 as well: turning the unit off keeps the speed it holds.
    if (this.isFanSpeedRequested && control.power !== false) {
      const fanSpeed = readFanSpeed();
      if (fanSpeed !== undefined) control.fanSpeed = fanSpeed;
    }
    if (this.swing.vertical !== undefined || this.swing.horizontal !== undefined) {
      control.swingMode = resolveSwingMode(unit.state?.swingMode ?? 'off', this.swing, unit.capabilities.swingModes);
    }
    // Auto off goes back to the speed the fan last ran at, or to a middle speed when it was never seen off auto.
    if (this.fanAuto === true) control.fanSpeed = 'auto';
    else if (this.fanAuto === false && (control.fanSpeed ?? unit.state?.fanSpeed) === 'auto') {
      control.fanSpeed = unit.lastManualFanSpeed ?? unit.fanSteps[Math.floor(unit.fanSteps.length / 2)];
    }
    this.control = {};
    this.setpoints = {};
    this.swing = {};
    this.specialModes = {};
    this.fanAuto = undefined;
    this.isFanSpeedRequested = false;
    return { control, specialModes };
  }

  // A mode takes the setpoint of the thermostat mode it is shown as. Dry and fan take none, whatever they are shown as.
  // In auto the unit has one setpoint for Matter's two, so the one that moved away from the unit's own wins.
  private resolveSetpoint(mode: OperatingMode | undefined, unit: UnitSnapshot): number | undefined {
    if (mode === undefined || mode === 'dehumidify' || mode === 'fan') return undefined;
    const { cool, heat } = this.setpoints;
    const shown = unit.modeReplacements[mode] ?? mode;
    if (shown === 'cool') return cool;
    if (shown === 'heat') return heat;
    if (shown !== 'auto') return undefined;
    const current = unit.state?.targetTemperatureInC;
    return [cool, heat].find((setpoint) => setpoint !== undefined && setpoint !== current);
  }
}
