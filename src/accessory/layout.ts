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

import { type DaikinDeviceConfig, type ModeReplacements, THERMOSTAT_MODES } from '../config.js';
import { getModeReplacements, hasFanAuto, type ReportedSensors } from '../controls.js';
import { getFanSteps, getTemperatureRange, getThermostatProfile, type ModeSelectValue, type ThermostatProfile } from '../mapping.js';

/** How the controls of a device are laid out in Matter, worked out once from what its unit accepts and how it is configured. */
export interface AccessoryLayout {
  /** Which Thermostat features the device has: those of the unit, and those of the mode replacements. */
  profile: ThermostatProfile;
  /** The thermostat mode each mode of the unit is shown as, or none when the device has no mode replacements. */
  modeReplacements: ModeReplacements;
  /** The fan speeds a controller can pick, slowest first, without `auto`. */
  fanSteps: FanSpeed[];
  /** The fan speeds on the scale of the fan control, from its first step: the fan steps, with `auto` below or above them when it is a step. */
  fanPositions: FanSpeed[];
  /** Whether the device has a fan control in Matter. */
  hasFan: boolean;
  /** Whether the device has a fan of its own beside the air conditioner, with the same fan control. */
  hasSeparateFan: boolean;
  /** The axes the rocking of each fan control has, the swing of the unit: none when the device shows no rocking. */
  rockAxes: { vertical: boolean; horizontal: boolean };
  /** Whether the device has an on/off switch for each axis the unit swings on. */
  hasSwingSwitches: boolean;
  /** Whether the fan control has the Matter fan mode Auto: the unit takes the `auto` fan speed, and it is no step. */
  hasFanAuto: boolean;
  /** Whether the `auto` fan speed is a step of the fan control. */
  hasFanAutoStep: boolean;
  /** Whether the device has an on/off switch for the `auto` fan speed. */
  hasFanAutoSwitch: boolean;
  /** Whether the fan control offers its speeds as steps, besides the percent. */
  hasFanSteps: boolean;
  /** The limits of the heating setpoint, in °C: those of the mode shown as Heat. */
  heatLimits: TemperatureRange;
  /** The limits of the cooling setpoint, in °C: those of the mode shown as Cool. */
  coolLimits: TemperatureRange;
  /** Whether the device shows the indoor humidity. */
  hasHumidity: boolean;
  /** Whether that humidity is also on a sensor of its own, besides the air conditioner. */
  hasSeparateHumiditySensor: boolean;
  /** Off and the modes the mode select picks from, or none when the device has no mode select. */
  modeSelectModes: readonly ModeSelectValue[];
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
  const modeReplacements = getModeReplacements(config.modeReplacements, capabilities.modes);
  // A replacement can give the thermostat a mode the unit lacks, such as Heat on a unit that only cools.
  const profile = getThermostatProfile([...capabilities.modes, ...Object.values(modeReplacements)]);
  if (profile === undefined) throw new Error(`"${config.name}" neither cools nor heats and cannot be exposed as an air conditioner`);
  const fanSteps = getFanSteps(capabilities.fanSpeeds);
  // The setpoint of a thermostat mode is that of the mode of the unit shown as it.
  const shownAs = (shown: 'cool' | 'heat'): OperatingMode => THERMOSTAT_MODES.find((mode) => modeReplacements[mode] === shown) ?? shown;
  // With both heating and cooling, Matter wants the cooling limits at or above the heating limits.
  const heatRange = getTemperatureRange(capabilities, shownAs('heat'));
  const coolRange = getTemperatureRange(capabilities, shownAs('cool'));
  const hasFan = config.fanControl !== 'hidden' && fanSteps.length > 0;
  const hasAutoStep = hasFan && capabilities.fanSpeeds.includes('auto') && (config.fanAutoControl === 'firstStep' || config.fanAutoControl === 'lastStep');
  const hasAutoSwitch = config.fanAutoControl === 'switch' && hasFanAuto(capabilities);
  const swingsOn = (axis: 'vertical' | 'horizontal'): boolean => capabilities.swingModes.includes(axis) || capabilities.swingModes.includes('both');
  // The rocking is the native place of the swing, on every fan control. It is never beside the switches or the select:
  // Apple Home is reported to upset it, so they take its place.
  const hasRocking = hasFan && config.swingControl === 'native';
  let fanPositions = fanSteps;
  if (hasAutoStep) fanPositions = config.fanAutoControl === 'firstStep' ? ['auto', ...fanSteps] : [...fanSteps, 'auto'];
  return {
    profile,
    modeReplacements,
    fanSteps,
    fanPositions,
    hasFan,
    hasSeparateFan: hasFan && config.hasSeparateFan,
    rockAxes: { vertical: hasRocking && swingsOn('vertical'), horizontal: hasRocking && swingsOn('horizontal') },
    // Without a fan control, the swing has no rocking, and its switches stand for it.
    hasSwingSwitches: config.swingControl === 'switches' || (config.swingControl === 'native' && !hasFan),
    // A step takes the place of the fan mode Auto, which holds no percent: the two cannot show at once. A switch is an endpoint of its own beside it.
    hasFanAuto: capabilities.fanSpeeds.includes('auto') && !hasAutoStep,
    hasFanAutoStep: hasAutoStep,
    hasFanAutoSwitch: hasAutoSwitch,
    hasFanSteps: config.fanControl === 'steps',
    heatLimits: profile === 'heatCool' ? { ...heatRange, min: Math.min(heatRange.min, coolRange.min) } : heatRange,
    coolLimits: profile === 'heatCool' ? { ...coolRange, max: Math.max(coolRange.max, heatRange.max) } : coolRange,
    hasHumidity: reportedSensors.hasHumidity,
    hasSeparateHumiditySensor: reportedSensors.hasHumidity && config.hasSeparateHumiditySensor,
    modeSelectModes: config.modeControl === 'select' ? ['off', ...capabilities.modes] : [],
    swingSelectModes: config.swingControl === 'select' ? capabilities.swingModes : [],
    hasOutdoorTemperature: reportedSensors.hasOutdoorTemperature && config.hasOutdoorTemperatureSensor,
    isComposed: config.isComposed,
  };
}
