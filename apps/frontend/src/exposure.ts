/**
 * @file apps/frontend/src/exposure.ts
 * @description How a device appears in Matter: the choices a draft starts with.
 * @author Calvin Che
 * @license Apache-2.0
 */

import type { Adapter, AvailableControls, Exposure, StoredDevice } from './api.js';
import type { Draft } from './state.js';

/** Copy the choices of how a device appears in Matter, and nothing else. */
export function pickExposure(source: Exposure): Exposure {
  const { fanControl, fanSpeedWhenHidden, swingControl, swingModeWhenHidden, modeControl, modeSwitches, fanAutoControl, hasSeparateFan, specialModeSwitches, hasOutdoorTemperatureSensor, hasSeparateHumiditySensor, isComposed } =
    source;
  return {
    fanControl,
    fanSpeedWhenHidden,
    swingControl,
    swingModeWhenHidden,
    modeControl,
    modeSwitches: [...modeSwitches],
    fanAutoControl,
    hasSeparateFan,
    specialModeSwitches: [...specialModeSwitches],
    hasOutdoorTemperatureSensor,
    hasSeparateHumiditySensor,
    isComposed,
  };
}

// What a new device starts with. What a stored device without a setting gets is the default of `parseDeviceConfig`
// in the plugin, which stands for how the plugin behaved before that setting existed: the two may differ.
const defaultExposure: Exposure = {
  fanControl: 'steps',
  fanSpeedWhenHidden: 'keep',
  swingControl: 'switches',
  swingModeWhenHidden: 'keep',
  modeControl: 'native',
  modeSwitches: [],
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
export const noControls: AvailableControls = { fanSteps: [], hasFanAuto: false, hasSwing: false, hasDryMode: false, hasFanMode: false, specialModes: [] };
