/**
 * @file src/accessory/matterState.ts
 * @description This file contains the reads and the writes of the state of one air conditioner on its Matter endpoints.
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

import type { DaikinSensors, DaikinState, FanSpeed, OperatingMode, SpecialMode } from 'daikin-local-control';
import type { MatterbridgeEndpoint } from 'matterbridge';
import { FanControl, ModeSelect, OnOff, RelativeHumidityMeasurement, TemperatureMeasurement, Thermostat } from 'matterbridge/matter/clusters';
import { isValidNumber } from 'matterbridge/utils';

import type { SwitchedMode } from '../config.js';
import { fanStepToPercent, getSwingAxes, modeSelectChoices, percentToFanStep, type SelectChoices, swingSelectChoices, toMatterTemperature, toSystemMode } from '../mapping.js';
import type { AccessoryLayout } from './layout.js';

/** The Matter endpoints that stand for one air conditioner. */
export interface AccessoryEndpoints {
  /** The room air conditioner. */
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
}

/**
 * Read the fan speed a controller set on the fan control
 *
 * @param {MatterbridgeEndpoint} endpoint The endpoint that has the fan control.
 * @param {readonly FanSpeed[]} fanPositions The fan speeds on the scale of the fan control, from its first step.
 * @returns {FanSpeed | undefined} The fan speed, or undefined when the fan control holds none the unit takes.
 */
export function readFanSpeed(endpoint: MatterbridgeEndpoint, fanPositions: readonly FanSpeed[]): FanSpeed | undefined {
  const fanMode: unknown = endpoint.getAttribute(FanControl, 'fanMode');
  const percent: unknown = endpoint.getAttribute(FanControl, 'percentSetting');
  // Matter refuses the fan mode Auto on a unit without it, so a unit that reaches here takes `auto`.
  if (fanMode === FanControl.FanMode.Auto) return 'auto';
  // The fan of an air conditioner has no off, so off and 0 are the first step.
  if (!isValidNumber(percent, 0, 100)) return undefined;
  return fanPositions[percentToFanStep(fanPositions.length, percent) - 1];
}

/**
 * Work out the Thermostat running state of a unit
 *
 * The adapter does not say whether the compressor runs, so a unit that is on counts as running in its mode.
 *
 * @param {DaikinState} state The state of the unit.
 * @param {DaikinSensors} sensors The readings of the unit.
 * @returns {Record<string, boolean>} The running state bitmap.
 */
function getRunningState(state: DaikinState, sensors: DaikinSensors): Record<string, boolean> {
  const indoor = sensors.indoorTemperatureInC;
  const target = state.targetTemperatureInC;
  const isAutoCooling = state.mode === 'auto' && indoor !== null && target !== null && indoor > target;
  const isAutoHeating = state.mode === 'auto' && indoor !== null && target !== null && indoor < target;
  return {
    heat: state.power && (state.mode === 'heat' || isAutoHeating),
    cool: state.power && (state.mode === 'cool' || state.mode === 'dehumidify' || isAutoCooling),
    fan: state.power,
    heatStage2: false,
    coolStage2: false,
    fanStage2: false,
    fanStage3: false,
  };
}

/**
 * Write the setpoint of a unit to the Thermostat setpoints of the mode it is shown in
 *
 * @param {MatterbridgeEndpoint} endpoint The air conditioner.
 * @param {AccessoryLayout} layout How the controls of the device are laid out.
 * @param {OperatingMode} mode The mode of the unit.
 * @param {number} targetTemperatureInC The setpoint of the unit in °C, which is clamped to the limits of each Matter setpoint.
 * @returns {Promise<void>} Resolves when the setpoints are written.
 */
async function applySetpoint(endpoint: MatterbridgeEndpoint, layout: AccessoryLayout, mode: OperatingMode, targetTemperatureInC: number): Promise<void> {
  const { profile, coolLimits, heatLimits } = layout;
  const hasCooling = profile !== 'heat';
  const hasHeating = profile !== 'cool';
  const cool = toMatterTemperature(Math.min(Math.max(targetTemperatureInC, coolLimits.min), coolLimits.max));
  const heat = toMatterTemperature(Math.min(Math.max(targetTemperatureInC, heatLimits.min), heatLimits.max));
  // The setpoints are those of the mode the thermostat shows.
  const shown = layout.modeReplacements[mode] ?? mode;
  if (hasCooling && (shown === 'cool' || shown === 'auto')) await endpoint.updateAttribute(Thermostat, 'occupiedCoolingSetpoint', cool);
  if (hasHeating && (shown === 'heat' || shown === 'auto')) await endpoint.updateAttribute(Thermostat, 'occupiedHeatingSetpoint', heat);
}

/**
 * Write the fan speed of a unit to the fan control
 *
 * Edge cases:
 *  - a fan speed that is no step of the unit is not written
 *
 * @param {MatterbridgeEndpoint} endpoint The endpoint that has the fan control.
 * @param {AccessoryLayout} layout How the controls of the device are laid out.
 * @param {FanSpeed} fanSpeed The fan speed of the unit.
 * @returns {Promise<void>} Resolves when the fan control is written.
 */
async function applyFanSpeed(endpoint: MatterbridgeEndpoint, layout: AccessoryLayout, fanSpeed: FanSpeed): Promise<void> {
  if (fanSpeed === 'auto' && layout.hasFanAuto) {
    await endpoint.updateAttribute(FanControl, 'fanMode', FanControl.FanMode.Auto);
    return;
  }
  const step = layout.fanPositions.indexOf(fanSpeed) + 1;
  if (step === 0) return;
  const percent = fanStepToPercent(layout.fanPositions.length, step);
  // Writing the percent makes the fan control server derive the fan mode and the speed setting.
  await endpoint.updateAttribute(FanControl, 'percentSetting', percent);
  await endpoint.updateAttribute(FanControl, 'percentCurrent', percent);
  if (layout.hasFanSteps) await endpoint.updateAttribute(FanControl, 'speedCurrent', step);
}

/**
 * Write a value of the unit to its mode select
 *
 * Edge cases:
 *  - a value the select does not list is not written: Matter refuses it
 *
 * @param {MatterbridgeEndpoint | undefined} endpoint The mode select, or undefined when the device has none.
 * @param {SelectChoices<T>} choices The values the select picks from.
 * @param {readonly T[]} supported The values the select lists.
 * @param {T} value The value of the unit.
 * @returns {Promise<void>} Resolves when the mode select is written.
 */
async function applySelect<T extends string>(endpoint: MatterbridgeEndpoint | undefined, choices: SelectChoices<T>, supported: readonly T[], value: T): Promise<void> {
  if (endpoint !== undefined && supported.includes(value)) await endpoint.updateAttribute(ModeSelect, 'currentMode', choices.values.indexOf(value));
}

/**
 * Write the readings of a unit to the Matter endpoints of its device
 *
 * A reading the unit does not give is written as no value, never left at what it was.
 *
 * @param {AccessoryEndpoints} endpoints The endpoints of the device.
 * @param {AccessoryLayout} layout How the controls of the device are laid out.
 * @param {DaikinSensors} sensors The readings of the unit.
 * @returns {Promise<void>} Resolves when every reading is written.
 */
export async function applySensors(endpoints: AccessoryEndpoints, layout: AccessoryLayout, sensors: DaikinSensors): Promise<void> {
  const { endpoint } = endpoints;
  const indoor = sensors.indoorTemperatureInC === null ? null : toMatterTemperature(sensors.indoorTemperatureInC);
  // The measured temperature is what the thermostat server of matter.js takes as its input, but written alone it leaves
  // the local temperature as it was, in matter.js 0.17: so the local temperature is written too.
  await endpoint.updateAttribute('Thermostat', 'externalMeasuredIndoorTemperature', indoor);
  await endpoint.updateAttribute(Thermostat, 'localTemperature', indoor);
  // Matter counts both in hundredths: of a percent, and of a degree.
  const humidity = sensors.indoorHumidityInPercent === null ? null : Math.round(sensors.indoorHumidityInPercent * 100);
  if (layout.hasHumidity) await endpoint.updateAttribute(RelativeHumidityMeasurement, 'measuredValue', humidity);
  await endpoints.humiditySensor?.updateAttribute(RelativeHumidityMeasurement, 'measuredValue', humidity);
  const outdoor = sensors.outdoorTemperatureInC === null ? null : toMatterTemperature(sensors.outdoorTemperatureInC);
  await endpoints.outdoorTemperatureSensor?.updateAttribute(TemperatureMeasurement, 'measuredValue', outdoor);
}

/**
 * Write the state and the readings of a unit to the Matter endpoints of its device
 *
 * @param {AccessoryEndpoints} endpoints The endpoints of the device.
 * @param {AccessoryLayout} layout How the controls of the device are laid out.
 * @param {DaikinState} state The state of the unit.
 * @param {DaikinSensors} sensors The readings of the unit.
 * @returns {Promise<void>} Resolves when every endpoint is written.
 */
export async function applyState(endpoints: AccessoryEndpoints, layout: AccessoryLayout, state: DaikinState, sensors: DaikinSensors): Promise<void> {
  const { endpoint } = endpoints;
  await endpoint.updateAttribute(OnOff, 'onOff', state.power);
  await endpoint.updateAttribute(Thermostat, 'systemMode', state.power ? toSystemMode(state.mode, layout.profile, layout.modeReplacements) : Thermostat.SystemMode.Off);
  if (state.targetTemperatureInC !== null) await applySetpoint(endpoint, layout, state.mode, state.targetTemperatureInC);
  await applySensors(endpoints, layout, sensors);
  await endpoint.updateAttribute(Thermostat, 'thermostatRunningState', getRunningState(state, sensors));
  const axes = getSwingAxes(state.swingMode);
  if (layout.hasFan) {
    const fanControl = endpoints.fan ?? endpoint;
    await applyFanSpeed(fanControl, layout, state.fanSpeed);
    const { vertical, horizontal } = layout.rockAxes;
    if (vertical || horizontal)
      await fanControl.updateAttribute('FanControl', 'rockSetting', { rockLeftRight: horizontal && axes.horizontal, rockUpDown: vertical && axes.vertical, rockRound: false });
  }
  // A fan of its own is on and off with the air conditioner, and keeps showing the speed the unit holds.
  await endpoints.fan?.updateAttribute(OnOff, 'onOff', state.power);
  await endpoints.verticalSwitch?.updateAttribute(OnOff, 'onOff', axes.vertical);
  await endpoints.horizontalSwitch?.updateAttribute(OnOff, 'onOff', axes.horizontal);
  for (const [mode, modeSwitch] of endpoints.modeSwitches) await modeSwitch.updateAttribute(OnOff, 'onOff', state.power && state.mode === mode);
  await endpoints.fanAutoSwitch?.updateAttribute(OnOff, 'onOff', state.fanSpeed === 'auto');
  for (const [specialMode, specialModeSwitch] of endpoints.specialModeSwitches) await specialModeSwitch.updateAttribute(OnOff, 'onOff', state.specialModes.includes(specialMode));
  await applySelect(endpoints.modeSelect, modeSelectChoices, layout.modeSelectModes, state.power ? state.mode : 'off');
  await applySelect(endpoints.swingSelect, swingSelectChoices, layout.swingSelectModes, state.swingMode);
}
