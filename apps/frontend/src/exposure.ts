/**
 * @file apps/frontend/src/exposure.ts
 * @description How a device appears in Matter: the choices a draft starts with.
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

import type { Adapter, AvailableControls, Exposure, ModeReplacements, StoredDevice, SwitchedMode } from './api.js';
import { type Draft, view } from './state.js';

/**
 * Copy the choices of how a device appears in Matter, and nothing else
 *
 * @param {Exposure} source What holds the choices, such as a draft or a stored device.
 * @returns {Exposure} The choices, with the lists and the replacements copied.
 */
export function pickExposure(source: Exposure): Exposure {
  const {
    fanControl,
    fanSpeedWhenHidden,
    swingControl,
    swingAxes,
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
    swingAxes,
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
  swingAxes: 'both',
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

/** The longest name Matter takes. */
const maxNameLength = 32;

/**
 * Get a name no device has yet: the name the adapter tells, or that name with a number after it, such as "Bedroom 2"
 *
 * @param {string} base The name the adapter tells, or an empty string when it has not told one.
 * @param {ReadonlySet<string>} taken The names that are taken.
 * @returns {string} The name, of at most 32 characters, or the empty string it was given.
 */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (base === '' || !taken.has(base)) return base;
  for (let count = 2; ; count++) {
    const suffix = ` ${count}`;
    const name = `${base.slice(0, maxNameLength - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * Get the names a draft cannot take: those of the stored devices but its own, and those of the other drafts of the run
 *
 * @param {Draft} draft The draft.
 * @returns {Set<string>} The names.
 */
export function takenNames(draft: Draft): Set<string> {
  const stored = (view.setup?.devices ?? []).filter((device) => device.macAddress !== draft.adapter.macAddress).map((device) => device.name);
  const queued = view.queue.filter((other) => other !== draft).map((other) => other.name);
  return new Set([...stored, ...queued].filter((name) => name !== ''));
}

/**
 * Create the drafts of the adapters picked in the Find step, each named after its adapter
 *
 * Adapters can share a name, so each draft gets one no stored device and no draft before it has.
 *
 * @param {readonly Adapter[]} adapters The adapters.
 * @returns {Draft[]} The drafts, new, with the default choices until the plugin says what each unit can do.
 */
export function draftsFromAdapters(adapters: readonly Adapter[]): Draft[] {
  const taken = new Set((view.setup?.devices ?? []).map((device) => device.name));
  return adapters.map((adapter) => {
    const name = uniqueName(adapter.name ?? '', taken);
    if (name !== '') taken.add(name);
    return { adapter, name, isNew: true, ...pickExposure(defaultExposure) };
  });
}

/**
 * Create the draft of a stored device, for its options or for reconnecting it
 *
 * @param {StoredDevice} device The stored device.
 * @returns {Draft} The draft, with the choices the device is stored with.
 */
export function draftFromStored(device: StoredDevice): Draft {
  const { capabilities, controls, name, macAddress, host, protocol, requiresRegistration, usesHttps, requiresLocalPassword } = device;
  // The stored name is the one given in the setup page: the check in Connect reads the adapter's own.
  const adapter: Adapter = { host, protocol, macAddress, requiresRegistration, usesHttps, requiresLocalPassword };
  return { adapter, name, isNew: false, capabilities, controls, ...pickExposure(device) };
}

/** What a unit the plugin told nothing about can have: no control and no switch. */
export const noControls: AvailableControls = {
  fanSteps: [],
  hasFanAuto: false,
  hasSwing: false,
  swingModes: [],
  swingsOnBothAxes: false,
  switchableModes: [],
  lackingModes: [],
  specialModes: [],
};

/**
 * Tell whether a mode of the unit can be shown as a thermostat mode, given what its other modes are shown as
 *
 * It is as `getModeReplacements` in the plugin keeps it: only as a mode the unit lacks, no two as the same one, and as
 * Auto only on a thermostat that both cools and heats, counting the replacements, because Matter has Auto only with both.
 *
 * @param {SwitchedMode} mode The mode of the unit.
 * @param {SwitchedMode} replacement The thermostat mode to show it as.
 * @param {ModeReplacements} replacements What the other modes are shown as.
 * @param {AvailableControls} controls What the unit can do.
 * @returns {boolean} Whether the mode can be shown as that thermostat mode.
 */
export function canReplace(mode: SwitchedMode, replacement: SwitchedMode, replacements: ModeReplacements, controls: AvailableControls): boolean {
  if (!controls.switchableModes.includes(mode) || !controls.lackingModes.includes(replacement)) return false;
  const others = controls.switchableModes.filter((other) => other !== mode).map((other) => replacements[other]);
  if (others.includes(replacement)) return false;
  if (replacement !== 'auto') return true;
  const modes = new Set([...controls.switchableModes, ...others]);
  return modes.has('cool') && modes.has('heat');
}

/**
 * Keep the replacements the plugin keeps for a unit: those it can take
 *
 * @param {ModeReplacements} replacements The replacements chosen.
 * @param {AvailableControls} controls What the unit can do.
 * @returns {ModeReplacements} The replacements the unit can take.
 */
export function fitModeReplacements(replacements: ModeReplacements, controls: AvailableControls): ModeReplacements {
  const fitted: ModeReplacements = {};
  for (const mode of controls.switchableModes) {
    const replacement = replacements[mode];
    if (replacement !== undefined && canReplace(mode, replacement, replacements, controls)) fitted[mode] = replacement;
  }
  return fitted;
}
