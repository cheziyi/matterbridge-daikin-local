/**
 * @file apps/frontend/src/presets.ts
 * @description The presets of the Options step: each fills in the choices of how a device appears in Matter.
 * @author Calvin Che
 * @license Apache-2.0
 */

import type { AvailableControls, Exposure } from './api.js';
import { pickExposure } from './exposure.js';
import type { Draft } from './state.js';

export type PresetName = 'apple' | 'google' | 'full' | 'minimal';

export const presets: Record<PresetName, { title: string; text: string }> = {
  apple: {
    title: 'Apple Home',
    text: 'Fan speed as a percentage, the humidity on a sensor of its own, and a switch for everything Home has no control for: swing, dry mode, fan mode and auto fan.',
  },
  google: { title: 'Google Home', text: 'Fan speed as steps, swing switches and a dry mode switch.' },
  full: { title: 'Full', text: 'Every control, switch and sensor this unit can have, special modes and the outdoor temperature included.' },
  minimal: { title: 'Minimal', text: 'No fan control, no swing control and no switches. The fan and the swing stay as they are.' },
};

/**
 * The choices a preset makes for a unit: never a switch or a control the unit has no use for. A preset says which
 * controls and switches there are, not whether they are parts of the air conditioner: that choice stays as it is.
 */
export function presetExposure(name: PresetName, controls: AvailableControls): Omit<Exposure, 'isComposed'> {
  const isMinimal = name === 'minimal';
  return {
    fanControl: isMinimal || controls.fanSteps.length === 0 ? 'hidden' : name === 'apple' ? 'percent' : 'steps',
    fanSpeedWhenHidden: 'keep',
    swingControl: isMinimal || !controls.hasSwing ? 'hidden' : 'switches',
    swingModeWhenHidden: 'keep',
    hasDryModeSwitch: !isMinimal && controls.hasDryMode,
    hasFanModeSwitch: (name === 'apple' || name === 'full') && controls.hasFanMode,
    hasFanAutoSwitch: (name === 'apple' || name === 'full') && controls.hasFanAuto,
    // No preset takes the fan off the air conditioner: that is for an app that shows no fan speed there.
    hasSeparateFan: false,
    specialModeSwitches: name === 'full' ? [...controls.specialModes] : [],
    // An app may show the outdoor temperature as that of the room it puts the sensor in, until the sensor is moved.
    hasOutdoorTemperatureSensor: name === 'full',
    // Home is reported to show a humidity on a sensor of its own only.
    hasSeparateHumiditySensor: name === 'apple',
  };
}

/** Whether the choices in a draft are exactly those of a preset, leaving aside what the unit has no use for. */
export function matchesPreset(draft: Draft, name: PresetName, controls: AvailableControls): boolean {
  const chosen = pickExposure(draft);
  if (controls.fanSteps.length === 0) Object.assign(chosen, { fanControl: 'hidden', fanSpeedWhenHidden: 'keep' });
  // The choice shows nowhere while the fan is hidden.
  if (chosen.fanControl === 'hidden') chosen.hasSeparateFan = false;
  if (!controls.hasSwing) Object.assign(chosen, { swingControl: 'hidden', swingModeWhenHidden: 'keep' });
  chosen.specialModeSwitches = controls.specialModes.filter((mode) => chosen.specialModeSwitches.includes(mode));
  return JSON.stringify(chosen) === JSON.stringify({ ...presetExposure(name, controls), isComposed: chosen.isComposed });
}
