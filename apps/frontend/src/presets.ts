/**
 * @file apps/frontend/src/presets.ts
 * @description The presets of the Options step: each fills in the choices of how a device appears in Matter.
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

import type { AvailableControls, Exposure } from './api.js';
import { fitModeReplacements, pickExposure } from './exposure.js';
import type { Draft } from './state.js';

export type PresetName = 'apple' | 'google' | 'matter';

export const presets: Record<PresetName, { title: string; text: string }> = {
  apple: {
    title: 'Apple Home',
    text: 'Fan speed as a percentage, the swing as the rocking of the fan on one axis, the humidity on a sensor of its own too, and a switch for auto fan and for each of dry and fan, each a device of its own.',
  },
  google: {
    title: 'Google Home',
    text: 'Fan speed as steps, the swing as the rocking of the fan on one axis, the humidity on a sensor of its own too, and a switch for auto fan and for each of dry and fan, each a device of its own.',
  },
  matter: {
    title: 'Full Matter support',
    text: 'For apps that show every Matter control: fan speed as steps with its auto mode, the swing as the rocking of the fan, a switch for each special mode and the outdoor temperature, all as one device.',
  },
};

/**
 * The choices a preset makes for a unit: never a switch or a control the unit has no use for. The Apple Home and the
 * Google Home presets make the switches, a fan of its own and a humidity sensor of its own devices of their own, and
 * the Full Matter support preset makes them parts of the air conditioner.
 */
export function presetExposure(name: PresetName, controls: AvailableControls): Exposure {
  const isMatter = name === 'matter';
  // An app that shows every Matter control gets the rocking of the fan control on every axis, or its switches on a unit
  // without a fan control. Home shows the rocking as a single Oscillate on/off, so it gets one axis alone, left and right
  // where the unit swings on both, and Google Home gets the same. Both leave the swing as it is on a unit without a fan
  // control, rather than add a switch for each axis.
  const hasRocking = controls.hasSwing && (isMatter || controls.fanSteps.length > 0);
  const swingControl: Exposure['swingControl'] = hasRocking ? 'native' : 'hidden';
  // Home and Google Home are reported to offer off, cool, heat and auto alone, so dry and fan get a switch each where
  // the unit has them.
  const modeSwitches = isMatter ? [] : controls.switchableModes.filter((mode) => mode === 'dehumidify' || mode === 'fan');
  return {
    fanControl: controls.fanSteps.length === 0 ? 'hidden' : name === 'apple' ? 'percent' : 'steps',
    fanSpeedWhenHidden: 'keep',
    swingControl,
    swingAxes: !isMatter && hasRocking && controls.swingsOnBothAxes ? 'horizontal' : 'both',
    swingModeWhenHidden: 'keep',
    // An app that shows every Matter control has dry and fan among the modes of the thermostat.
    modeControl: modeSwitches.length > 0 ? 'switches' : 'native',
    modeSwitches,
    modeReplacements: {},
    // Neither Home nor Google Home is known to show the auto fan mode, which the switch is beside.
    fanAutoControl: !isMatter && controls.hasFanAuto ? 'switch' : 'native',
    // No preset takes the fan off the air conditioner: that is for an app that shows no fan speed there.
    hasSeparateFan: false,
    // Matter has nothing for the special modes, so a switch is the one way to them.
    specialModeSwitches: isMatter ? [...controls.specialModes] : [],
    // An app may show the outdoor temperature as that of the room it puts the sensor in, until the sensor is moved.
    hasOutdoorTemperatureSensor: isMatter,
    // Home is reported to show a humidity on a sensor of its own only, and Google Home lists the humidity sensor among
    // what it supports but not the Room Air Conditioner. The humidity stays on the air conditioner too.
    hasSeparateHumiditySensor: !isMatter,
    // Home shows the parts of a composed device without their names. Google lists neither composed devices nor the
    // Room Air Conditioner among what Google Home supports, but says every device behind a bridge appears as normal.
    isComposed: isMatter,
  };
}

/** Whether the choices in a draft are exactly those of a preset, leaving aside what the unit has no use for. */
export function matchesPreset(draft: Draft, name: PresetName, controls: AvailableControls): boolean {
  const chosen = pickExposure(draft);
  if (controls.fanSteps.length === 0) Object.assign(chosen, { fanControl: 'hidden', fanSpeedWhenHidden: 'keep' });
  // The choice shows nowhere while the fan is hidden.
  if (chosen.fanControl === 'hidden') chosen.hasSeparateFan = false;
  // Nor does the auto fan speed on a unit without one, a step of a hidden fan, or a switch beside a fixed fan speed.
  const isAutoStep = chosen.fanAutoControl === 'firstStep' || chosen.fanAutoControl === 'lastStep';
  const hasFixedFanSpeed = chosen.fanControl === 'hidden' && chosen.fanSpeedWhenHidden !== 'keep';
  if (!controls.hasFanAuto || (isAutoStep && chosen.fanControl === 'hidden') || hasFixedFanSpeed) chosen.fanAutoControl = 'native';
  if (!controls.hasSwing) Object.assign(chosen, { swingControl: 'hidden', swingModeWhenHidden: 'keep' });
  // Without a fan control, the rocking is the switches.
  if (chosen.fanControl === 'hidden' && chosen.swingControl === 'switches') chosen.swingControl = 'native';
  // The axes show only for the rocking or the switches of a unit that swings on both axes.
  if ((chosen.swingControl !== 'native' && chosen.swingControl !== 'switches') || !controls.swingsOnBothAxes) chosen.swingAxes = 'both';
  // The switches are a choice only while they are chosen, and both they and the replacements only for what the unit
  // has. A mode select shows nothing more than the thermostat on a unit without a dry or a fan mode.
  chosen.modeSwitches = chosen.modeControl === 'switches' ? controls.switchableModes.filter((mode) => chosen.modeSwitches.includes(mode)) : [];
  chosen.modeReplacements = fitModeReplacements(chosen.modeReplacements, controls);
  const isOfUse: Record<Exposure['modeControl'], boolean> = {
    native: true,
    select: controls.switchableModes.includes('dehumidify') || controls.switchableModes.includes('fan'),
    switches: chosen.modeSwitches.length > 0,
  };
  if (!isOfUse[chosen.modeControl]) chosen.modeControl = 'native';
  chosen.specialModeSwitches = controls.specialModes.filter((mode) => chosen.specialModeSwitches.includes(mode));
  return JSON.stringify(chosen) === JSON.stringify(presetExposure(name, controls));
}
