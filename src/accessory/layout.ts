/**
 * @file src/accessory/layout.ts
 * @description This file contains how the controls of one air conditioner are laid out in Matter.
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

import type { DaikinCapabilities, FanSpeed, OperatingMode, SwingMode, TemperatureRange } from 'daikin-local-control';

import type { DaikinDeviceConfig } from '../config.js';
import type { ReportedSensors } from '../controls.js';
import { getFanSteps, getTemperatureRange, getThermostatProfile, type ThermostatProfile } from '../mapping.js';

/** How the controls of a device are laid out in Matter, worked out once from what its unit accepts and how it is configured. */
export interface AccessoryLayout {
  /** Which Thermostat features the unit takes. */
  profile: ThermostatProfile;
  /** The fan speeds a controller can pick, slowest first, without `auto`. */
  fanSteps: FanSpeed[];
  /** Whether the device has a fan control in Matter. */
  hasFan: boolean;
  /** Whether that fan control is a fan of its own, instead of a part of the air conditioner. */
  hasSeparateFan: boolean;
  /** Whether the unit takes the `auto` fan speed. */
  hasFanAuto: boolean;
  /** Whether the fan control offers its speeds as steps, besides the percent. */
  hasFanSteps: boolean;
  /** The limits of the heating setpoint, in °C. */
  heatLimits: TemperatureRange;
  /** The limits of the cooling setpoint, in °C. */
  coolLimits: TemperatureRange;
  /** Whether the device shows the indoor humidity. */
  hasHumidity: boolean;
  /** Whether that humidity is on a sensor of its own, instead of on the air conditioner. */
  hasSeparateHumiditySensor: boolean;
  /** The modes the mode select picks from, or none when the device has no mode select. */
  modeSelectModes: readonly OperatingMode[];
  /** The swing modes the swing select picks from, or none when the device has no swing select. */
  swingSelectModes: readonly SwingMode[];
  /** Whether the device has a sensor for the outdoor temperature. */
  hasOutdoorTemperature: boolean;
  /** Whether the fan, the switches and the humidity sensor of the device are parts of its air conditioner, instead of devices of their own. */
  isComposed: boolean;
}

/**
 * Work out how the controls of a device are laid out in Matter
 *
 * @param {DaikinDeviceConfig} config The device.
 * @param {DaikinCapabilities} capabilities What its unit accepts.
 * @param {ReportedSensors} reportedSensors The readings its unit has given.
 * @returns {AccessoryLayout} The layout.
 * @throws {Error} When the unit neither cools nor heats, so no Matter thermostat can stand for it.
 */
export function getAccessoryLayout(config: DaikinDeviceConfig, capabilities: DaikinCapabilities, reportedSensors: ReportedSensors): AccessoryLayout {
  const profile = getThermostatProfile(capabilities.modes);
  if (profile === undefined) throw new Error(`"${config.name}" neither cools nor heats and cannot be exposed as an air conditioner`);
  const fanSteps = getFanSteps(capabilities.fanSpeeds);
  // With both heating and cooling, Matter wants the cooling limits at or above the heating limits.
  const heatRange = getTemperatureRange(capabilities, 'heat');
  const coolRange = getTemperatureRange(capabilities, 'cool');
  const hasFan = config.fanControl !== 'hidden' && fanSteps.length > 0;
  return {
    profile,
    fanSteps,
    hasFan,
    hasSeparateFan: hasFan && config.hasSeparateFan,
    hasFanAuto: capabilities.fanSpeeds.includes('auto'),
    hasFanSteps: config.fanControl === 'steps',
    heatLimits: profile === 'heatCool' ? { ...heatRange, min: Math.min(heatRange.min, coolRange.min) } : heatRange,
    coolLimits: profile === 'heatCool' ? { ...coolRange, max: Math.max(coolRange.max, heatRange.max) } : coolRange,
    hasHumidity: reportedSensors.hasHumidity,
    hasSeparateHumiditySensor: reportedSensors.hasHumidity && config.hasSeparateHumiditySensor,
    modeSelectModes: config.hasModeSelect ? capabilities.modes : [],
    swingSelectModes: config.swingControl === 'select' ? capabilities.swingModes : [],
    hasOutdoorTemperature: reportedSensors.hasOutdoorTemperature && config.hasOutdoorTemperatureSensor,
    isComposed: config.isComposed,
  };
}
