/**
 * @file src/mapping.ts
 * @description This file contains the pure conversions between the Daikin model and the Matter clusters.
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

import { type DaikinCapabilities, FAN_SPEEDS, type FanSpeed, type OperatingMode, SWING_MODES, type SwingMode, type TemperatureRange } from 'daikin-local-control';
import { FanControl, type ModeSelect, Thermostat } from 'matterbridge/matter/clusters';

import { maxDeviceNameLength } from './config.js';

/** Which Thermostat features a unit takes: both, cooling alone or heating alone. */
export type ThermostatProfile = 'heatCool' | 'cool' | 'heat';

/** The range used for a mode whose range the unit does not report, in °C. */
export const fallbackTemperatureRange: TemperatureRange = { min: 16, max: 32, step: 1 };

/**
 * The values a mode select picks from, in the order it lists them, and what each is called there
 *
 * The mode number of a value is its place in `values`, so that it stays the same whatever the unit takes.
 */
export interface SelectChoices<T extends string> {
  values: readonly T[];
  labels: Readonly<Record<T, string>>;
}

/** The modes of the unit on its mode select. */
export const modeSelectChoices: SelectChoices<OperatingMode> = {
  values: ['auto', 'cool', 'heat', 'dehumidify', 'fan'],
  labels: { auto: 'Auto', cool: 'Cool', heat: 'Heat', dehumidify: 'Dry', fan: 'Fan Only' },
};

/** The swing modes of the unit on its swing select. */
export const swingSelectChoices: SelectChoices<SwingMode> = {
  values: SWING_MODES,
  labels: { off: 'Off', vertical: 'Vertical', horizontal: 'Horizontal', both: 'Both' },
};

/**
 * List the modes of a mode select
 *
 * @param {SelectChoices<T>} choices The values the select picks from.
 * @param {readonly T[]} supported The values the unit takes.
 * @returns {ModeSelect.ModeOption[]} One mode for each value the unit takes, in the order of `choices`.
 */
export function toModeOptions<T extends string>(choices: SelectChoices<T>, supported: readonly T[]): ModeSelect.ModeOption[] {
  return choices.values.flatMap((value, mode) => (supported.includes(value) ? [{ label: choices.labels[value], mode, semanticTags: [] }] : []));
}

/** A change to the swing: an axis left out keeps swinging or keeps still. */
export interface SwingChange {
  vertical?: boolean;
  horizontal?: boolean;
}

/**
 * List the fan speeds a controller can pick, slowest first
 *
 * `auto` is left out: it is the Matter fan mode Auto, not a step.
 *
 * @param {readonly FanSpeed[]} fanSpeeds The fan speeds the unit takes.
 * @returns {FanSpeed[]} `silent` and `level1` to `level5`, each only when the unit takes it.
 */
export function getFanSteps(fanSpeeds: readonly FanSpeed[]): FanSpeed[] {
  return FAN_SPEEDS.filter((speed) => speed !== 'auto' && fanSpeeds.includes(speed));
}

/**
 * Convert a fan step to the Matter percent that stands for it
 *
 * The percent is the top of the step's share of 100, rounded down, so that `percentToFanStep` turns it back into the same step.
 *
 * @param {number} stepCount How many steps the unit takes (>= 1).
 * @param {number} step The step, from 1 for the slowest to `stepCount`.
 * @returns {number} The percent, 1..100.
 */
export function fanStepToPercent(stepCount: number, step: number): number {
  return Math.max(1, Math.floor((step * 100) / stepCount));
}

/**
 * Convert a Matter percent to a fan step
 *
 * Edge cases:
 *  - clamps to 1..`stepCount`, so 0 is the slowest step: the caller decides what off means
 *
 * @param {number} stepCount How many steps the unit takes (>= 1).
 * @param {number} percent The percent, 0..100.
 * @returns {number} The step, from 1 for the slowest to `stepCount`.
 */
export function percentToFanStep(stepCount: number, percent: number): number {
  return Math.min(Math.max(Math.ceil((stepCount * percent) / 100), 1), stepCount);
}

/**
 * Pick the Matter fan mode sequence for a unit
 *
 * @param {number} stepCount How many steps the unit takes (>= 1).
 * @param {boolean} hasAuto Whether the unit takes the `auto` fan speed.
 * @returns {FanControl.FanModeSequence} The sequence with as many of Low, Medium and High as the unit has steps for.
 */
export function getFanModeSequence(stepCount: number, hasAuto: boolean): FanControl.FanModeSequence {
  if (stepCount >= 3) return hasAuto ? FanControl.FanModeSequence.OffLowMedHighAuto : FanControl.FanModeSequence.OffLowMedHigh;
  if (stepCount === 2) return hasAuto ? FanControl.FanModeSequence.OffLowHighAuto : FanControl.FanModeSequence.OffLowHigh;
  return hasAuto ? FanControl.FanModeSequence.OffHighAuto : FanControl.FanModeSequence.OffHigh;
}

/**
 * Pick the Thermostat features for a unit
 *
 * @param {readonly OperatingMode[]} modes The operating modes the unit offers.
 * @returns {ThermostatProfile | undefined} The profile, or undefined for a unit that neither cools nor heats.
 */
export function getThermostatProfile(modes: readonly OperatingMode[]): ThermostatProfile | undefined {
  const cools = modes.includes('cool');
  const heats = modes.includes('heat');
  if (cools && heats) return 'heatCool';
  if (cools) return 'cool';
  return heats ? 'heat' : undefined;
}

/**
 * Convert a Daikin operating mode to a Matter system mode
 *
 * Edge cases:
 *  - `auto` on a unit that only cools or only heats -> Cool or Heat, because Matter has Auto only with both
 *
 * @param {OperatingMode} mode The Daikin mode.
 * @param {ThermostatProfile} profile The Thermostat features of the unit.
 * @returns {Thermostat.SystemMode} The Matter system mode.
 */
export function toSystemMode(mode: OperatingMode, profile: ThermostatProfile): Thermostat.SystemMode {
  switch (mode) {
    case 'cool':
      return Thermostat.SystemMode.Cool;
    case 'heat':
      return Thermostat.SystemMode.Heat;
    case 'dehumidify':
      return Thermostat.SystemMode.Dry;
    case 'fan':
      return Thermostat.SystemMode.FanOnly;
    default:
      if (profile === 'heatCool') return Thermostat.SystemMode.Auto;
      return profile === 'cool' ? Thermostat.SystemMode.Cool : Thermostat.SystemMode.Heat;
  }
}

const operatingModesBySystemMode: Readonly<Partial<Record<Thermostat.SystemMode, OperatingMode>>> = {
  [Thermostat.SystemMode.Auto]: 'auto',
  [Thermostat.SystemMode.Cool]: 'cool',
  [Thermostat.SystemMode.Precooling]: 'cool',
  [Thermostat.SystemMode.Heat]: 'heat',
  [Thermostat.SystemMode.EmergencyHeat]: 'heat',
  [Thermostat.SystemMode.FanOnly]: 'fan',
  [Thermostat.SystemMode.Dry]: 'dehumidify',
};

/**
 * Convert a Matter system mode to a Daikin operating mode
 *
 * @param {Thermostat.SystemMode} systemMode The Matter system mode, other than Off.
 * @param {readonly OperatingMode[]} modes The operating modes the unit offers.
 * @returns {OperatingMode | undefined} The Daikin mode, or undefined when the unit does not offer it.
 */
export function toOperatingMode(systemMode: Thermostat.SystemMode, modes: readonly OperatingMode[]): OperatingMode | undefined {
  const mode = operatingModesBySystemMode[systemMode];
  return mode !== undefined && modes.includes(mode) ? mode : undefined;
}

/**
 * Clamp a setpoint to the range of a mode and round it to the range's step
 *
 * Edge cases:
 *  - not a finite number -> the bottom of the range
 *  - a step of 0 or less is taken as 1
 *
 * @param {number} temperatureInC The requested setpoint in °C.
 * @param {TemperatureRange} range The range of the target mode, in °C.
 * @returns {number} The setpoint the unit takes, in °C.
 */
export function clampTemperature(temperatureInC: number, range: TemperatureRange): number {
  if (!Number.isFinite(temperatureInC)) return range.min;
  const step = range.step > 0 ? range.step : 1;
  const clamped = Math.min(Math.max(temperatureInC, range.min), range.max);
  const rounded = range.min + Math.round((clamped - range.min) / step) * step;
  return Math.round(Math.min(rounded, range.max) * 100) / 100;
}

/**
 * Convert a temperature to the Matter encoding
 *
 * @param {number} temperatureInC The temperature in °C.
 * @returns {number} The temperature in °C * 100, rounded.
 */
export function toMatterTemperature(temperatureInC: number): number {
  return Math.round(temperatureInC * 100);
}

/**
 * Get the setpoint range of a mode
 *
 * @param {DaikinCapabilities} capabilities What the unit accepts.
 * @param {OperatingMode} mode The mode.
 * @returns {TemperatureRange} The range the unit reports for the mode, or 16 to 32 °C in whole degrees when it reports none.
 */
export function getTemperatureRange(capabilities: DaikinCapabilities, mode: OperatingMode): TemperatureRange {
  return capabilities.targetTemperaturesInC[mode] ?? fallbackTemperatureRange;
}

/**
 * Split a swing mode into its two axes
 *
 * @param {SwingMode} swingMode The swing mode.
 * @returns {Required<SwingChange>} Whether the louvers swing vertically and horizontally.
 */
export function getSwingAxes(swingMode: SwingMode): Required<SwingChange> {
  return {
    vertical: swingMode === 'vertical' || swingMode === 'both',
    horizontal: swingMode === 'horizontal' || swingMode === 'both',
  };
}

/**
 * Work out the swing mode after a switch is turned on or off
 *
 * Edge cases:
 *  - both axes asked for on a unit without `both` -> the axis just turned on swings alone
 *  - any other mode the unit does not take -> the current mode is kept
 *
 * @param {SwingMode} current The swing mode the unit holds.
 * @param {SwingChange} change The axes to turn on or off.
 * @param {readonly SwingMode[]} supported The swing modes the unit takes.
 * @returns {SwingMode} The swing mode to send.
 */
export function resolveSwingMode(current: SwingMode, change: SwingChange, supported: readonly SwingMode[]): SwingMode {
  const axes = getSwingAxes(current);
  const vertical = change.vertical ?? axes.vertical;
  const horizontal = change.horizontal ?? axes.horizontal;
  let wanted: SwingMode = 'off';
  if (vertical && horizontal) wanted = 'both';
  else if (vertical) wanted = 'vertical';
  else if (horizontal) wanted = 'horizontal';
  if (supported.includes(wanted)) return wanted;
  if (wanted === 'both') {
    const single: SwingMode = change.horizontal === true ? 'horizontal' : 'vertical';
    if (supported.includes(single)) return single;
  }
  return current;
}

/**
 * Compose the name of an extra endpoint of a device
 *
 * Edge cases:
 *  - a result longer than 32 characters, the longest Matter node label, has its base name cut short, never its suffix
 *
 * @param {string} baseName The device name.
 * @param {string} suffix What the endpoint is, such as `Vertical Swing`.
 * @returns {string} The base name, a space and the suffix.
 */
export function composeDeviceName(baseName: string, suffix: string): string {
  const room = maxDeviceNameLength - suffix.length - 1;
  return `${baseName.slice(0, Math.max(room, 1)).trimEnd()} ${suffix}`;
}
