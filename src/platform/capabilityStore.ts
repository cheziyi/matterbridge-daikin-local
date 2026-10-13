/**
 * @file src/platform/capabilityStore.ts
 * @description This file contains the store of what each unit accepts, kept in the platform storage.
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

import type { DaikinCapabilities } from 'daikin-local-control';
import { isValidBoolean, isValidObject } from 'matterbridge/utils';
import type { NodeStorage } from 'node-persist-manager';

import type { DaikinDeviceConfig } from '../config.js';
import type { ReportedSensors } from '../controls.js';

/** The device whose unit is described: only the MAC address of its adapter is read. */
type StoredUnit = Pick<DaikinDeviceConfig, 'macAddress'>;

/**
 * Tell whether a stored value looks like the capabilities of a unit
 *
 * @param {unknown} value The stored value.
 * @returns {boolean} True when the lists the plugin reads are there.
 */
function isCapabilities(value: unknown): value is DaikinCapabilities {
  if (!isValidObject(value)) return false;
  const candidate = value as Partial<Record<keyof DaikinCapabilities, unknown>>;
  const hasLists = Array.isArray(candidate.modes) && Array.isArray(candidate.fanSpeeds) && Array.isArray(candidate.swingModes);
  return hasLists && isValidObject(candidate.targetTemperaturesInC) && isValidObject(candidate.specialModes);
}

/**
 * Tell whether a stored value looks like the readings a unit has given
 *
 * @param {unknown} value The stored value.
 * @returns {boolean} True when both flags are there.
 */
function isReportedSensors(value: unknown): value is ReportedSensors {
  if (!isValidObject(value)) return false;
  const candidate = value as Partial<Record<keyof ReportedSensors, unknown>>;
  return isValidBoolean(candidate.hasHumidity) && isValidBoolean(candidate.hasOutdoorTemperature);
}

/**
 * Get the key the capabilities of a unit are stored under
 *
 * They are kept under the MAC address, so that a new name or a new address keeps what is known about the unit.
 *
 * @param {StoredUnit} device The device.
 * @returns {string} The storage key.
 */
function getKey(device: StoredUnit): string {
  return `capabilities:${device.macAddress}`;
}

/**
 * Get the key the readings a unit has given are stored under
 *
 * @param {StoredUnit} device The device.
 * @returns {string} The storage key.
 */
function getSensorsKey(device: StoredUnit): string {
  return `sensors:${device.macAddress}`;
}

/**
 * What each unit accepts and which readings it has given, kept between restarts so that a device starts without asking
 * its unit first.
 */
export class CapabilityStore {
  private readonly getStorage: () => NodeStorage | undefined;

  /**
   * Create the store
   *
   * @param {() => NodeStorage | undefined} getStorage Gets the platform storage, which is not there until the platform is ready.
   */
  constructor(getStorage: () => NodeStorage | undefined) {
    this.getStorage = getStorage;
  }

  /**
   * Read what a unit accepts
   *
   * @param {StoredUnit} device The device.
   * @returns {Promise<DaikinCapabilities | undefined>} The stored capabilities, or undefined when none are stored or they cannot be read.
   */
  async read(device: StoredUnit): Promise<DaikinCapabilities | undefined> {
    const stored: unknown = await this.getStorage()?.get(getKey(device));
    return isCapabilities(stored) ? stored : undefined;
  }

  /**
   * Store what a unit accepts
   *
   * @param {StoredUnit} device The device.
   * @param {DaikinCapabilities} capabilities What its unit accepts.
   * @returns {Promise<void>} Resolves when the capabilities are stored.
   */
  async write(device: StoredUnit, capabilities: DaikinCapabilities): Promise<void> {
    await this.getStorage()?.set(getKey(device), capabilities);
  }

  /**
   * Read which readings a unit has given
   *
   * @param {StoredUnit} device The device.
   * @returns {Promise<ReportedSensors | undefined>} The stored readings, or undefined when none are stored or they cannot be read.
   */
  async readSensors(device: StoredUnit): Promise<ReportedSensors | undefined> {
    const stored: unknown = await this.getStorage()?.get(getSensorsKey(device));
    return isReportedSensors(stored) ? stored : undefined;
  }

  /**
   * Store which readings a unit has given
   *
   * @param {StoredUnit} device The device.
   * @param {ReportedSensors} sensors The readings its unit has given.
   * @returns {Promise<void>} Resolves when the readings are stored.
   */
  async writeSensors(device: StoredUnit, sensors: ReportedSensors): Promise<void> {
    await this.getStorage()?.set(getSensorsKey(device), sensors);
  }

  /**
   * Forget what is known about a unit
   *
   * @param {StoredUnit} device The device.
   * @returns {Promise<void>} Resolves when its capabilities and its readings are removed.
   */
  async remove(device: StoredUnit): Promise<void> {
    await this.getStorage()?.remove(getKey(device));
    await this.getStorage()?.remove(getSensorsKey(device));
  }
}
