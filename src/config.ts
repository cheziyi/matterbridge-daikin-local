/**
 * @file src/config.ts
 * @description This file contains the plugin configuration model and its validation.
 * @author Calvin Che
 * @created 2026-10-12
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

import {
  DAIKIN_PROTOCOLS,
  type DaikinDevice,
  type DaikinProtocol,
  FAN_SPEEDS,
  type FanSpeed,
  type OperatingMode,
  SPECIAL_MODES,
  type SpecialMode,
  SWING_MODES,
  type SwingMode,
} from 'daikin-local-control';
import type { BasePlatformConfig } from 'matterbridge';
import { isValidBoolean, isValidNumber, isValidObject, isValidString } from 'matterbridge/utils';

/** How the fan speed is exposed to Matter. */
export const FAN_CONTROLS = ['steps', 'percent', 'hidden'] as const;

export type FanControlOption = (typeof FAN_CONTROLS)[number];

/** How the swing is exposed to Matter: a switch for each axis, a mode select of the swing modes, or nothing. */
export const SWING_CONTROLS = ['switches', 'select', 'hidden'] as const;

export type SwingControlOption = (typeof SWING_CONTROLS)[number];

/**
 * How the auto fan speed is exposed to Matter: natively, as the fan mode Auto of the fan control, as an on/off switch
 * beside that fan mode, or as a step of the fan control below the slowest speed of the unit or above its fastest, in
 * place of the fan mode. Each but the native fan mode alone is for apps that show no fan mode Auto.
 */
export const FAN_AUTO_CONTROLS = ['native', 'switch', 'firstStep', 'lastStep'] as const;

export type FanAutoControlOption = (typeof FAN_AUTO_CONTROLS)[number];

/**
 * How the modes are exposed to Matter besides the thermostat of the air conditioner: natively alone, as modes of the
 * thermostat, or also as a mode select of every mode of the unit, or as an on/off switch for each mode in
 * `modeSwitches`, or with modes of the unit shown as the thermostat modes `modeReplacements` puts them in. Each but the
 * native modes alone is for apps whose climate controls lack some of the modes.
 */
export const MODE_CONTROLS = ['native', 'select', 'switches', 'replacements'] as const;

export type ModeControlOption = (typeof MODE_CONTROLS)[number];

/** Every mode, in the order of the Thermostat system modes. */
export const THERMOSTAT_MODES = ['auto', 'cool', 'heat', 'dehumidify', 'fan'] as const satisfies readonly OperatingMode[];

/** The modes that can each get an on/off switch: every mode. */
export const SWITCHED_MODES = THERMOSTAT_MODES;

export type SwitchedMode = (typeof SWITCHED_MODES)[number];

/**
 * The thermostat mode each mode of the unit is shown as, such as `{ dehumidify: 'heat' }` for a unit that only cools:
 * a mode the unit lacks, so that none of its own modes is lost, and no two the same.
 */
export type ModeReplacements = Partial<Record<OperatingMode, OperatingMode>>;

/** The value of a hidden setting that leaves the unit as it is. */
export const KEEP_SETTING = 'keep';

export type HiddenFanSpeed = typeof KEEP_SETTING | FanSpeed;

export type HiddenSwingMode = typeof KEEP_SETTING | SwingMode;

const hiddenFanSpeeds = [KEEP_SETTING, ...FAN_SPEEDS] as const;
const hiddenSwingModes = [KEEP_SETTING, ...SWING_MODES] as const;

export const defaultPollIntervalInSeconds = 5;
export const minPollIntervalInSeconds = 2;
export const maxPollIntervalInSeconds = 3600;

/**
 * How old, in seconds, the state of the last poll may be for a command to be built from it without reading the unit
 * first, unless the configuration says otherwise. A command built from an older state would undo more of what was
 * changed on the remote control meanwhile.
 */
export const defaultMaxStateAgeForCommandInSeconds = 30;

/** The longest device name accepted, which is also the longest Matter node label. */
export const maxDeviceNameLength = 32;

/** How a device appears in Matter: its controls, its switches and its sensors. */
export interface DaikinDeviceExposure {
  fanControl: FanControlOption;
  /** The fan speed sent with every command while the fan is hidden, or `keep`. */
  fanSpeedWhenHidden: HiddenFanSpeed;
  swingControl: SwingControlOption;
  /** The swing mode sent with every command while the swing is hidden, or `keep`. */
  swingModeWhenHidden: HiddenSwingMode;
  /** How the dry and fan modes are exposed besides the thermostat: see `MODE_CONTROLS`. */
  modeControl: ModeControlOption;
  /** The modes that each get an on/off switch while `modeControl` is `switches`. */
  modeSwitches: SwitchedMode[];
  /** The thermostat mode each mode of the unit is shown as while `modeControl` is `replacements`. */
  modeReplacements: ModeReplacements;
  /** How the auto fan speed is exposed: see `FAN_AUTO_CONTROLS`. */
  fanAutoControl: FanAutoControlOption;
  /** Whether the fan control is a fan of its own in Matter, instead of a part of the air conditioner. */
  hasSeparateFan: boolean;
  /** The special modes that each get an on/off switch in Matter. */
  specialModeSwitches: SpecialMode[];
  /** Whether Matter gets a sensor for the outdoor temperature, once the unit gives it. */
  hasOutdoorTemperatureSensor: boolean;
  /** Whether the indoor humidity is also on a sensor of its own in Matter, besides the air conditioner, once the unit gives it. */
  hasSeparateHumiditySensor: boolean;
  /**
   * Whether the fan of its own, the switches and the humidity sensor of its own are parts of the air conditioner in
   * Matter, instead of devices of their own: what Matter calls a composed device. The outdoor temperature sensor is
   * always a device of its own.
   */
  isComposed: boolean;
}

/**
 * The stored configuration of one air conditioner.
 *
 * The device is identified by the MAC address of its adapter, because its address on the network and its name can both
 * change.
 */
export interface DaikinDeviceConfig extends DaikinDeviceExposure {
  /** The name the adapter announces. It is the name of the device in Matter, and no two stored devices share one. */
  name: string;
  /** Twelve upper case hexadecimal digits in pairs joined by colons, such as `A4:08:EA:CC:91:D4`. */
  macAddress: string;
  /** Address, with `:port` when the adapter announces one. */
  host: string;
  protocol: DaikinProtocol;
  requiresRegistration: boolean;
  usesHttps: boolean;
  requiresLocalPassword: boolean;
  /** The child lock code, for a device whose `requiresLocalPassword` is true. */
  localPassword?: string;
}

export type DaikinPlatformConfig = BasePlatformConfig & {
  /** 32 lower case hexadecimal digits, or what an edit by hand left there: see `normalizeTerminalUuid`. */
  terminalUuid?: string;
  /** Each a `DaikinDeviceConfig`, or what another version or an edit by hand left there: see `parseDeviceConfigs`. */
  devices?: unknown[];
  pollIntervalInSeconds?: number;
  /** How old the state of the last poll may be for a command to be built from it: see `normalizeMaxStateAgeForCommand`. */
  maxStateAgeForCommandInSeconds?: number;
  /** Counts the times the plugin itself stored the devices or the terminal uuid: see `DaikinPlatform.onConfigChanged`. */
  setupRevision?: number;
};

const hostPattern = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?$/;
const terminalUuidPattern = /^[0-9a-f]{32}$/;
const macAddressPattern = /^[0-9A-F]{12}$/;

/**
 * Check whether a value is one of the members of a literal list
 *
 * @param {readonly T[]} members The accepted values.
 * @param {unknown} value The value to check.
 * @returns {boolean} True when the value is a member.
 */
function isMember<T extends string>(members: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (members as readonly string[]).includes(value);
}

/**
 * Parse the stored mode replacements
 *
 * Whether the unit has a mode or lacks it is not known here: `getModeReplacements` keeps what the unit can take.
 *
 * Edge cases:
 *  - an entry that is not from a mode to another mode is dropped
 *  - a thermostat mode that a mode earlier in `THERMOSTAT_MODES` is already shown as is dropped: no two modes share one
 *
 * @param {Record<string, unknown>} stored The stored entries.
 * @returns {{ replacements: ModeReplacements; dropped: Record<string, unknown> }} The replacements in the order of `THERMOSTAT_MODES`, and the entries that were dropped.
 */
function parseModeReplacements(stored: Record<string, unknown>): { replacements: ModeReplacements; dropped: Record<string, unknown> } {
  const replacements: ModeReplacements = {};
  for (const mode of THERMOSTAT_MODES) {
    const replacement = stored[mode];
    if (isMember(THERMOSTAT_MODES, replacement) && replacement !== mode && !Object.values(replacements).includes(replacement)) replacements[mode] = replacement;
  }
  const dropped = Object.fromEntries(Object.entries(stored).filter(([mode]) => !isMember(THERMOSTAT_MODES, mode) || replacements[mode] === undefined));
  return { replacements, dropped };
}

/**
 * Check whether a value is an adapter address
 *
 * It accepts a host name or an IPv4 address, with an optional `:port`, and nothing that carries a scheme, a path or a query.
 *
 * @param {unknown} value The value to check.
 * @returns {boolean} True when the value is a usable address.
 */
export function isValidHost(value: unknown): value is string {
  return isValidString(value, 1, 260) && hostPattern.test(value);
}

/**
 * Normalize a terminal uuid to the form the Daikin library takes
 *
 * `createDaikinClient` throws for any other form. A uuid with dashes or in upper case, as most tools print one, is
 * brought to it.
 *
 * @param {unknown} value The value to normalize.
 * @returns {string | undefined} The uuid as 32 lower case hexadecimal digits, or undefined when the value is not a uuid.
 */
export function normalizeTerminalUuid(value: unknown): string | undefined {
  if (!isValidString(value, 32, 36)) return undefined;
  const digits = value.trim().toLowerCase().replaceAll('-', '');
  return terminalUuidPattern.test(digits) ? digits : undefined;
}

/**
 * Normalize a MAC address to upper case pairs joined by colons
 *
 * @param {unknown} value The value to normalize: twelve hexadecimal digits, with or without colons or dashes.
 * @returns {string | undefined} The address, such as `A4:08:EA:CC:91:D4`, or undefined when the value is not a MAC address.
 */
export function normalizeMacAddress(value: unknown): string | undefined {
  if (!isValidString(value, 12, 17)) return undefined;
  const digits = value.toUpperCase().replaceAll(/[:-]/g, '');
  return macAddressPattern.test(digits) ? digits.replaceAll(/..(?=..)/g, '$&:') : undefined;
}

/**
 * Normalize a device name
 *
 * @param {unknown} value The value to normalize.
 * @returns {string | undefined} The trimmed name, or undefined when it is empty or longer than 32 characters.
 */
export function normalizeDeviceName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  return name.length > 0 && name.length <= maxDeviceNameLength ? name : undefined;
}

/**
 * Normalize the poll interval
 *
 * Edge cases:
 *  - not a finite number -> the default of 5 seconds
 *  - clamps to 2..3600 seconds
 *
 * @param {unknown} value The configured interval in seconds.
 * @returns {number} The interval in seconds.
 */
export function normalizePollInterval(value: unknown): number {
  if (!isValidNumber(value)) return defaultPollIntervalInSeconds;
  return Math.min(Math.max(Math.round(value), minPollIntervalInSeconds), maxPollIntervalInSeconds);
}

/**
 * Normalize how old the state of the last poll may be for a command to be built from it
 *
 * Edge cases:
 *  - not a finite number -> the default of 30 seconds
 *  - clamps to 0..3600 seconds, the longest poll interval: 0 has every command read the unit first
 *
 * @param {unknown} value The configured age in seconds.
 * @returns {number} The age in seconds.
 */
export function normalizeMaxStateAgeForCommand(value: unknown): number {
  if (!isValidNumber(value)) return defaultMaxStateAgeForCommandInSeconds;
  return Math.min(Math.max(Math.round(value), 0), maxPollIntervalInSeconds);
}

/**
 * Parse one stored device
 *
 * The setup page stores every device in full, but a device stored by an older version lacks the settings added since.
 * A device needs a name, an address, a protocol and the MAC address of its adapter, and every other field falls back
 * to its default.
 *
 * A setting added later follows three rules:
 *  - it is never required: a fifth required field would drop every device stored before it
 *  - its default here is what the plugin did before the setting existed, so that a stored device comes back as it was.
 *    What a new device starts with is `defaultExposure` in the setup page, and may differ
 *  - renaming a value or changing what it means is not an addition: it needs a version number in the configuration,
 *    where no number stands for the shape of today
 *
 * Edge cases:
 *  - a setting that is stored but not valid falls back like one that is missing, and is reported
 *  - a special mode switch this version does not know is dropped and reported
 *
 * @param {unknown} value The stored value.
 * @param {(message: string) => void} [report] Called once for each setting that is stored but not valid.
 * @returns {DaikinDeviceConfig | undefined} The device, or undefined when one of those four is missing or not valid.
 */
export function parseDeviceConfig(value: unknown, report?: (message: string) => void): DaikinDeviceConfig | undefined {
  if (!isValidObject(value)) return undefined;
  const raw: Record<string, unknown> = { ...value };
  const name = normalizeDeviceName(raw.name);
  const macAddress = normalizeMacAddress(raw.macAddress);
  if (name === undefined || macAddress === undefined || !isValidHost(raw.host) || !isMember(DAIKIN_PROTOCOLS, raw.protocol)) return undefined;
  const useDefault = <T>(key: string, fallback: T): T => {
    if (raw[key] !== undefined) report?.(`"${name}" has the ${key} ${JSON.stringify(raw[key])}, which is not valid: ${JSON.stringify(fallback)} is used instead`);
    return fallback;
  };
  const specialModeSwitches: unknown[] = Array.isArray(raw.specialModeSwitches) ? raw.specialModeSwitches : useDefault('specialModeSwitches', []);
  const unknownSwitches = specialModeSwitches.filter((mode) => !isMember(SPECIAL_MODES, mode));
  if (unknownSwitches.length > 0) report?.(`"${name}" has special mode switches this version does not know, which are dropped: ${JSON.stringify(unknownSwitches)}`);
  const modeSwitches: unknown[] = Array.isArray(raw.modeSwitches) ? raw.modeSwitches : useDefault('modeSwitches', []);
  const unknownModeSwitches = modeSwitches.filter((mode) => !isMember(SWITCHED_MODES, mode));
  if (unknownModeSwitches.length > 0) report?.(`"${name}" has mode switches this version does not know, which are dropped: ${JSON.stringify(unknownModeSwitches)}`);
  const storedReplacements: Record<string, unknown> = isValidObject(raw.modeReplacements) ? { ...raw.modeReplacements } : useDefault('modeReplacements', {});
  const { replacements: modeReplacements, dropped: droppedReplacements } = parseModeReplacements(storedReplacements);
  if (Object.keys(droppedReplacements).length > 0) {
    report?.(`"${name}" has mode replacements this version does not take, which are dropped: ${JSON.stringify(droppedReplacements)}`);
  }
  const device: DaikinDeviceConfig = {
    name,
    macAddress,
    host: raw.host,
    protocol: raw.protocol,
    requiresRegistration: isValidBoolean(raw.requiresRegistration) ? raw.requiresRegistration : useDefault('requiresRegistration', false),
    usesHttps: isValidBoolean(raw.usesHttps) ? raw.usesHttps : useDefault('usesHttps', false),
    requiresLocalPassword: isValidBoolean(raw.requiresLocalPassword) ? raw.requiresLocalPassword : useDefault('requiresLocalPassword', false),
    fanControl: isMember(FAN_CONTROLS, raw.fanControl) ? raw.fanControl : useDefault('fanControl', 'steps'),
    fanSpeedWhenHidden: isMember(hiddenFanSpeeds, raw.fanSpeedWhenHidden) ? raw.fanSpeedWhenHidden : useDefault('fanSpeedWhenHidden', KEEP_SETTING),
    swingControl: isMember(SWING_CONTROLS, raw.swingControl) ? raw.swingControl : useDefault('swingControl', 'switches'),
    swingModeWhenHidden: isMember(hiddenSwingModes, raw.swingModeWhenHidden) ? raw.swingModeWhenHidden : useDefault('swingModeWhenHidden', KEEP_SETTING),
    modeControl: isMember(MODE_CONTROLS, raw.modeControl) ? raw.modeControl : useDefault('modeControl', 'native'),
    modeSwitches: SWITCHED_MODES.filter((mode) => modeSwitches.includes(mode)),
    modeReplacements,
    fanAutoControl: isMember(FAN_AUTO_CONTROLS, raw.fanAutoControl) ? raw.fanAutoControl : useDefault('fanAutoControl', 'native'),
    hasSeparateFan: isValidBoolean(raw.hasSeparateFan) ? raw.hasSeparateFan : useDefault('hasSeparateFan', false),
    specialModeSwitches: SPECIAL_MODES.filter((mode) => specialModeSwitches.includes(mode)),
    // Off although devices stored before the setting existed had the sensor: none of them was in use.
    hasOutdoorTemperatureSensor: isValidBoolean(raw.hasOutdoorTemperatureSensor) ? raw.hasOutdoorTemperatureSensor : useDefault('hasOutdoorTemperatureSensor', false),
    hasSeparateHumiditySensor: isValidBoolean(raw.hasSeparateHumiditySensor) ? raw.hasSeparateHumiditySensor : useDefault('hasSeparateHumiditySensor', false),
    // Composed although devices were stored before the setting existed: none of them was in use.
    isComposed: isValidBoolean(raw.isComposed) ? raw.isComposed : useDefault('isComposed', true),
  };
  if (isValidString(raw.localPassword, 1)) device.localPassword = raw.localPassword;
  // The code itself stays out of the log.
  else if (raw.localPassword !== undefined) report?.(`"${name}" has a child lock code that is not valid, which is ignored`);
  return device;
}

/**
 * Parse the stored device list
 *
 * Edge cases:
 *  - not an array -> an empty list
 *  - a device that is not complete or not valid is left out and reported: `getUnreadableDevices` lists those
 *  - a second device with a name or a MAC address already taken is dropped and reported
 *
 * @param {unknown} value The stored value.
 * @param {(message: string) => void} [report] Called once for each device that is left out, and for each setting that is stored but not valid.
 * @returns {DaikinDeviceConfig[]} The valid devices, in their stored order.
 */
export function parseDeviceConfigs(value: unknown, report?: (message: string) => void): DaikinDeviceConfig[] {
  const devices: DaikinDeviceConfig[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const device = parseDeviceConfig(entry, report);
    if (device === undefined) {
      report?.(
        'A stored device has no valid name, address, protocol or MAC address and is ignored. It stays in the configuration as it is until a device with its name or its MAC address is added in the setup page',
      );
    } else if (devices.some((other) => other.name === device.name)) {
      report?.(`A second stored device is named "${device.name}" and is ignored: no two devices share a name`);
    } else if (devices.some((other) => other.macAddress === device.macAddress)) {
      report?.(`"${device.name}" has the MAC address of another stored device and is ignored`);
    } else {
      devices.push(device);
    }
  }
  return devices;
}

/**
 * List the stored devices this version cannot read
 *
 * The plugin stores them again as they are, so that a version that reads them, or a correction by hand, still finds
 * them.
 *
 * Edge cases:
 *  - not an array -> an empty list
 *  - an entry with the name or the MAC address of one of `devices` is left out: that device took its place
 *
 * @param {unknown} value The stored device list, or the entries kept from it.
 * @param {readonly DaikinDeviceConfig[]} devices The devices that are stored now.
 * @returns {unknown[]} The entries `parseDeviceConfig` refuses, as they were stored.
 */
export function getUnreadableDevices(value: unknown, devices: readonly DaikinDeviceConfig[]): unknown[] {
  const entries: unknown[] = Array.isArray(value) ? value : [];
  return entries.filter((entry) => {
    if (parseDeviceConfig(entry) !== undefined) return false;
    const raw: Record<string, unknown> = isValidObject(entry) ? { ...entry } : {};
    const name = normalizeDeviceName(raw.name);
    const macAddress = normalizeMacAddress(raw.macAddress);
    return !devices.some((device) => device.name === name || device.macAddress === macAddress);
  });
}

/**
 * Convert a stored device to the device the Daikin client takes
 *
 * @param {DaikinDeviceConfig} config The stored device.
 * @returns {DaikinDevice} The device for `createDaikinClient`.
 */
export function toDaikinDevice(config: DaikinDeviceConfig): DaikinDevice {
  return {
    host: config.host,
    protocol: config.protocol,
    name: config.name,
    macAddress: config.macAddress,
    requiresRegistration: config.requiresRegistration,
    usesHttps: config.usesHttps,
    requiresLocalPassword: config.requiresLocalPassword,
  };
}

/**
 * Tell whether two stored devices are reached the same way
 *
 * @param {DaikinDeviceConfig} left One device.
 * @param {DaikinDeviceConfig} right The other device.
 * @returns {boolean} True when the address, the protocol and the credentials are the same.
 */
export function hasSameConnection(left: DaikinDeviceConfig, right: DaikinDeviceConfig): boolean {
  return (
    left.host === right.host &&
    left.protocol === right.protocol &&
    left.requiresRegistration === right.requiresRegistration &&
    left.usesHttps === right.usesHttps &&
    left.requiresLocalPassword === right.requiresLocalPassword &&
    left.localPassword === right.localPassword
  );
}

/**
 * Tell whether two stored devices are exposed to Matter the same way
 *
 * @param {DaikinDeviceConfig} left One device.
 * @param {DaikinDeviceConfig} right The other device.
 * @returns {boolean} True when both have the same name in Matter, the same controls, switches and sensors, and the same endpoints for them.
 */
export function hasSameExposure(left: DaikinDeviceConfig, right: DaikinDeviceConfig): boolean {
  return (
    left.name === right.name &&
    left.fanAutoControl === right.fanAutoControl &&
    left.hasSeparateFan === right.hasSeparateFan &&
    left.hasOutdoorTemperatureSensor === right.hasOutdoorTemperatureSensor &&
    left.hasSeparateHumiditySensor === right.hasSeparateHumiditySensor &&
    left.isComposed === right.isComposed &&
    left.specialModeSwitches.join() === right.specialModeSwitches.join() &&
    left.fanControl === right.fanControl &&
    left.swingControl === right.swingControl &&
    left.modeControl === right.modeControl &&
    left.modeSwitches.join() === right.modeSwitches.join() &&
    THERMOSTAT_MODES.every((mode) => left.modeReplacements[mode] === right.modeReplacements[mode])
  );
}
