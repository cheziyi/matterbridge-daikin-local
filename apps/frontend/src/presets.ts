/**
 * @file apps/frontend/src/presets.ts
 * @description The presets of the Options step: each fills in the choices of how a device appears in Matter.
 * @author Calvin Che
 * @license Apache-2.0
 */

import type { AvailableControls, Exposure } from './api.js';
import { pickExposure } from './exposure.js';
import type { Draft } from './state.js';

export type PresetName = 'apple' | 'google' | 'matter';

export const presets: Record<PresetName, { title: string; text: string }> = {
  apple: {
    title: 'Apple Home',
    text: 'Fan speed as a percentage, the humidity on a sensor of its own too, and a switch for auto fan, each a device of its own. The swing is not shown and stays as it is.',
  },
  google: { title: 'Google Home', text: 'Fan speed as steps, the humidity on a sensor of its own too, and a switch for auto fan, each a device of its own. The swing is not shown and stays as it is.' },
  matter: {
    title: 'Full Matter support',
    text: 'For apps that show every Matter control: fan speed as steps with its auto mode, the swing as a mode select, a switch for each special mode and the outdoor temperature, all as one device.',
  },
};

/**
 * The choices a preset makes for a unit: never a switch or a control the unit has no use for. The Apple Home and the
 * Google Home presets make the switches, a fan of its own and a humidity sensor of its own devices of their own, and
 * the Full Matter support preset makes them parts of the air conditioner.
 */
export function presetExposure(name: PresetName, controls: AvailableControls): Exposure {
  const isMatter = name === 'matter';
  // An app that shows every Matter control shows a mode select, which Matter has for what it has no cluster for. The
  // other presets leave the swing as it is, rather than add a switch for each axis.
  const swingControl: Exposure['swingControl'] = isMatter && controls.hasSwing ? 'select' : 'hidden';
  return {
    fanControl: controls.fanSteps.length === 0 ? 'hidden' : name === 'apple' ? 'percent' : 'steps',
    fanSpeedWhenHidden: 'keep',
    swingControl,
    swingModeWhenHidden: 'keep',
    // The thermostat has dry and fan only among its modes, and no preset adds a switch or a mode select for them.
    modeControl: 'native',
    modeSwitches: [],
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
  // The switches are a choice only while they are chosen, and nothing shows on a unit without a dry or a fan mode.
  if (chosen.modeControl !== 'switches') chosen.modeSwitches = [];
  if (!controls.hasDryMode && !controls.hasFanMode) Object.assign(chosen, { modeControl: 'native', modeSwitches: [] });
  chosen.specialModeSwitches = controls.specialModes.filter((mode) => chosen.specialModeSwitches.includes(mode));
  return JSON.stringify(chosen) === JSON.stringify(presetExposure(name, controls));
}
