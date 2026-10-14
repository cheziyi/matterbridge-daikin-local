/**
 * @file src/controls.ts
 * @description This file contains what the capabilities of a unit let its device have in Matter: its controls and its switches.
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

import { type DaikinCapabilities, type DaikinSensors, type FanSpeed, OPERATING_MODES, SPECIAL_MODES, type SpecialMode } from 'daikin-local-control';

import { type DaikinDeviceConfig, KEEP_SETTING } from './config.js';
import { getFanSteps } from './mapping.js';

/** The part of a unit's capabilities that decides which controls a device can have. */
export type ExposedCapabilities = Pick<DaikinCapabilities, 'modes' | 'fanSpeeds' | 'swingModes' | 'specialModes'>;

/**
 * Tell whether a unit can switch between the auto fan speed and a speed of its own
 *
 * @param {Pick<DaikinCapabilities, 'fanSpeeds'>} capabilities What the unit accepts.
 * @returns {boolean} True when the unit takes `auto` and at least one other fan speed.
 */
export function hasFanAuto(capabilities: Pick<DaikinCapabilities, 'fanSpeeds'>): boolean {
  return capabilities.fanSpeeds.includes('auto') && capabilities.fanSpeeds.length > 1;
}

/**
 * List the special modes a device can turn on and off
 *
 * @param {Pick<DaikinCapabilities, 'specialModes'>} capabilities What the unit accepts.
 * @returns {SpecialMode[]} Those of `powerful`, `econo` and `streamer` the unit takes in at least one of its modes.
 */
export function getSwitchableSpecialModes(capabilities: Pick<DaikinCapabilities, 'specialModes'>): SpecialMode[] {
  return SPECIAL_MODES.filter((specialMode) => OPERATING_MODES.some((mode) => capabilities.specialModes[mode].includes(specialMode)));
}

/** The controls and the switches a device can have in Matter, given what its unit accepts: what the setup page offers. */
export interface AvailableControls {
  /** The fan speeds a controller can pick, slowest first, without `auto`. Empty when apps cannot set the fan speed. */
  fanSteps: FanSpeed[];
  /** Whether the unit can switch between the auto fan speed and a speed of its own. */
  hasFanAuto: boolean;
  /** Whether apps can move the louvers. */
  hasSwing: boolean;
  /** Whether the unit has a dehumidify mode, which can get a switch. */
  hasDryMode: boolean;
  /** Whether the unit has a fan mode, which can get a switch. */
  hasFanMode: boolean;
  /** The special modes that can each get a switch. */
  specialModes: SpecialMode[];
}

/**
 * List the controls and the switches a device can have in Matter
 *
 * The setup page offers what is listed here, so that it never offers what `fitToCapabilities` drops.
 *
 * @param {ExposedCapabilities} capabilities What the unit accepts.
 * @returns {AvailableControls} What the device can have.
 */
export function getAvailableControls(capabilities: ExposedCapabilities): AvailableControls {
  return {
    fanSteps: getFanSteps(capabilities.fanSpeeds),
    hasFanAuto: hasFanAuto(capabilities),
    hasSwing: capabilities.swingModes.length > 0,
    hasDryMode: capabilities.modes.includes('dehumidify'),
    hasFanMode: capabilities.modes.includes('fan'),
    specialModes: getSwitchableSpecialModes(capabilities),
  };
}

/**
 * Drop the settings a unit does not take
 *
 * @param {DaikinDeviceConfig} device The device.
 * @param {ExposedCapabilities} capabilities What its unit accepts.
 * @returns {DaikinDeviceConfig} The device, with a fixed fan speed or swing mode the unit lacks replaced by `keep`, and without the switches, the mode select and the fan the unit has no use for.
 */
export function fitToCapabilities(device: DaikinDeviceConfig, capabilities: ExposedCapabilities): DaikinDeviceConfig {
  const fanSpeedWhenHidden = device.fanSpeedWhenHidden !== KEEP_SETTING && capabilities.fanSpeeds.includes(device.fanSpeedWhenHidden) ? device.fanSpeedWhenHidden : KEEP_SETTING;
  const swingModeWhenHidden =
    device.swingModeWhenHidden !== KEEP_SETTING && capabilities.swingModes.includes(device.swingModeWhenHidden) ? device.swingModeWhenHidden : KEEP_SETTING;
  // A fixed fan speed is sent with every command, so a switch for auto would not hold.
  const hasFixedFanSpeed = device.fanControl === 'hidden' && fanSpeedWhenHidden !== KEEP_SETTING;
  // The thermostat mode already offers every mode but these two.
  const hasModeSelect = device.hasModeSelect && (capabilities.modes.includes('dehumidify') || capabilities.modes.includes('fan'));
  return {
    ...device,
    fanSpeedWhenHidden,
    swingModeWhenHidden,
    // The mode select takes the place of the switches of the modes.
    hasDryModeSwitch: device.hasDryModeSwitch && !hasModeSelect && capabilities.modes.includes('dehumidify'),
    hasFanModeSwitch: device.hasFanModeSwitch && !hasModeSelect && capabilities.modes.includes('fan'),
    hasModeSelect,
    hasFanAutoSwitch: device.hasFanAutoSwitch && hasFanAuto(capabilities) && !hasFixedFanSpeed,
    hasSeparateFan: device.hasSeparateFan && device.fanControl !== 'hidden' && getFanSteps(capabilities.fanSpeeds).length > 0,
    specialModeSwitches: getSwitchableSpecialModes(capabilities).filter((mode) => device.specialModeSwitches.includes(mode)),
  };
}

/**
 * The readings a unit has given at least once, besides its room temperature
 *
 * No adapter says which readings its unit has, so one counts from the first time it is given. It then has its place in
 * Matter for good, and shows no value while the unit gives none.
 */
export interface ReportedSensors {
  /** Whether the unit has given its indoor humidity, which the air conditioner or a sensor of its own shows. */
  hasHumidity: boolean;
  /** Whether the unit has given its outdoor temperature, which gets a sensor of its own when one is asked for. */
  hasOutdoorTemperature: boolean;
}

export const noReportedSensors: ReportedSensors = { hasHumidity: false, hasOutdoorTemperature: false };

/**
 * Add the readings a unit just gave to the ones it is known to give
 *
 * @param {ReportedSensors} known The readings the unit gave before.
 * @param {DaikinSensors} sensors What the unit reads now.
 * @returns {ReportedSensors} `known` itself when the unit gave nothing new, so that a caller can tell by comparing the two.
 */
export function addReportedSensors(known: ReportedSensors, sensors: DaikinSensors): ReportedSensors {
  const hasHumidity = known.hasHumidity || sensors.indoorHumidityInPercent !== null;
  const hasOutdoorTemperature = known.hasOutdoorTemperature || sensors.outdoorTemperatureInC !== null;
  return hasHumidity === known.hasHumidity && hasOutdoorTemperature === known.hasOutdoorTemperature ? known : { hasHumidity, hasOutdoorTemperature };
}

/**
 * Tell whether two readings of what a unit accepts lead to the same Matter endpoints
 *
 * Only what the endpoints are built from is compared: the modes, the fan speeds, the swing modes, the setpoint ranges
 * and the special modes.
 *
 * @param {DaikinCapabilities} left One reading.
 * @param {DaikinCapabilities} right The other reading.
 * @returns {boolean} True when a device built from either reading has the same controls.
 */
export function hasSameControls(left: DaikinCapabilities, right: DaikinCapabilities): boolean {
  const describe = (capabilities: DaikinCapabilities): string => {
    const ranges = OPERATING_MODES.map((mode) => capabilities.targetTemperaturesInC[mode]).map((range) => (range === null ? null : [range.min, range.max, range.step]));
    const specialModes = OPERATING_MODES.map((mode) => capabilities.specialModes[mode]);
    return JSON.stringify([capabilities.modes, capabilities.fanSpeeds, capabilities.swingModes, ranges, specialModes]);
  };
  return describe(left) === describe(right);
}
