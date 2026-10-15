/**
 * @file apps/frontend/src/exposure.ts
 * @description How a device appears in Matter: the choices a draft starts with.
 * @author Calvin Che
 * @license Apache-2.0
 */

import type { Adapter, AvailableControls, Exposure, ModeReplacements, StoredDevice, SwitchedMode } from './api.js';
import type { Draft } from './state.js';

/** Copy the choices of how a device appears in Matter, and nothing else. */
export function pickExposure(source: Exposure): Exposure {
  const {
    fanControl,
    fanSpeedWhenHidden,
    swingControl,
    swingModeWhenHidden,
    modeControl,
    modeSwitches,
    modeReplacements,
    fanAutoControl,
    hasSeparateFan,
    specialModeSwitches,
    hasOutdoorTemperatureSensor,
    hasSeparateHumiditySensor,
    isComposed,
  } = source;
  return {
    fanControl,
    fanSpeedWhenHidden,
    swingControl,
    swingModeWhenHidden,
    modeControl,
    modeSwitches: [...modeSwitches],
    modeReplacements: { ...modeReplacements },
    fanAutoControl,
    hasSeparateFan,
    specialModeSwitches: [...specialModeSwitches],
    hasOutdoorTemperatureSensor,
    hasSeparateHumiditySensor,
    isComposed,
  };
}

// What a new device holds until the plugin says what its unit can do: it then takes the Apple Home preset. What a
// stored device without a setting gets is the default of `parseDeviceConfig` in the plugin, which stands for how the
// plugin behaved before that setting existed: the two may differ.
const defaultExposure: Exposure = {
  fanControl: 'steps',
  fanSpeedWhenHidden: 'keep',
  swingControl: 'switches',
  swingModeWhenHidden: 'keep',
  modeControl: 'native',
  modeSwitches: [],
  modeReplacements: {},
  fanAutoControl: 'native',
  hasSeparateFan: false,
  specialModeSwitches: [],
  hasOutdoorTemperatureSensor: false,
  hasSeparateHumiditySensor: false,
  isComposed: true,
};

export function draftFromAdapter(adapter: Adapter): Draft {
  return { adapter, name: adapter.name ?? '', isNew: true, ...pickExposure(defaultExposure) };
}

export function draftFromStored(device: StoredDevice): Draft {
  const { capabilities, controls, name, macAddress, host, protocol, requiresRegistration, usesHttps, requiresLocalPassword } = device;
  const adapter: Adapter = { host, protocol, name, macAddress, requiresRegistration, usesHttps, requiresLocalPassword };
  return { adapter, name, isNew: false, capabilities, controls, ...pickExposure(device) };
}

// What a unit the plugin told nothing about can have: no control and no switch.
export const noControls: AvailableControls = { fanSteps: [], hasFanAuto: false, hasSwing: false, switchableModes: [], lackingModes: [], specialModes: [] };

/**
 * Whether a mode of the unit can be shown as a thermostat mode, given what its other modes are shown as, as
 * `getModeReplacements` in the plugin keeps it: only as a mode the unit lacks, no two as the same one, and as Auto
 * only on a thermostat that both cools and heats, counting the replacements, because Matter has Auto only with both.
 */
export function canReplace(mode: SwitchedMode, replacement: SwitchedMode, replacements: ModeReplacements, controls: AvailableControls): boolean {
  if (!controls.switchableModes.includes(mode) || !controls.lackingModes.includes(replacement)) return false;
  const others = controls.switchableModes.filter((other) => other !== mode).map((other) => replacements[other]);
  if (others.includes(replacement)) return false;
  if (replacement !== 'auto') return true;
  const modes = new Set([...controls.switchableModes, ...others]);
  return modes.has('cool') && modes.has('heat');
}

/** The replacements the plugin keeps for a unit: those it can take. */
export function fitModeReplacements(replacements: ModeReplacements, controls: AvailableControls): ModeReplacements {
  const fitted: ModeReplacements = {};
  for (const mode of controls.switchableModes) {
    const replacement = replacements[mode];
    if (replacement !== undefined && canReplace(mode, replacement, replacements, controls)) fitted[mode] = replacement;
  }
  return fitted;
}
