/**
 * @file src/platform/discovery.ts
 * @description This file contains what a search of the network changes about a stored device.
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

import type { DaikinDevice } from 'daikin-local-control';
import type { AnsiLogger } from 'matterbridge/logger';

import { type DaikinDeviceConfig, hasSameConnection, normalizeDeviceName, normalizeMacAddress } from '../config.js';

/**
 * Work out what a search changes about a stored device
 *
 * A device is matched by the MAC address of its adapter, and takes the address, the name and the requirements its
 * adapter has now.
 *
 * Edge cases:
 *  - an adapter that speaks another protocol than the stored one -> undefined, with a warning
 *  - an Airbase adapter the search reports as classic -> its address and its name alone: a search reports an Airbase
 *    adapter as classic when the adapter was too slow to say which of the two it is
 *  - a name another stored device already has -> the stored name is kept
 *
 * @param {DaikinDeviceConfig} stored The stored device.
 * @param {readonly DaikinDeviceConfig[]} devices Every stored device.
 * @param {readonly DaikinDevice[]} found The adapters that answered the search.
 * @param {AnsiLogger} log The logger.
 * @returns {DaikinDeviceConfig | undefined} The updated device, or undefined when its adapter did not answer or nothing changed.
 */
export function getDiscoveredUpdate(
  stored: DaikinDeviceConfig,
  devices: readonly DaikinDeviceConfig[],
  found: readonly DaikinDevice[],
  log: AnsiLogger,
): DaikinDeviceConfig | undefined {
  const match = found.find((device) => normalizeMacAddress(device.macAddress) === stored.macAddress);
  if (match === undefined) return undefined;
  const isUnconfirmedAirbase = stored.protocol === 'airbase' && match.protocol === 'classic';
  if (match.protocol !== stored.protocol && !isUnconfirmedAirbase) {
    log.warn(`The adapter of "${stored.name}" now speaks ${match.protocol} instead of ${stored.protocol}: remove the device and add it again`);
    return undefined;
  }
  // The device takes the name its adapter has now, unless another stored device already has it.
  const name = normalizeDeviceName(match.name);
  const isNameFree = name !== undefined && !devices.some((other) => other !== stored && other.name === name);
  const updated: DaikinDeviceConfig = {
    ...stored,
    name: isNameFree ? name : stored.name,
    host: match.host,
    // The requirements of an adapter read as classic are not those of an Airbase adapter, so the stored ones stay.
    ...(isUnconfirmedAirbase
      ? {}
      : { requiresRegistration: match.requiresRegistration === true, usesHttps: match.usesHttps === true, requiresLocalPassword: match.requiresLocalPassword === true }),
  };
  return hasSameConnection(stored, updated) && updated.name === stored.name ? undefined : updated;
}
