/**
 * @file src/setup/probe.ts
 * @description This file contains the checks the guided setup runs against an adapter before a device is stored.
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
  ClassicDaikinClient,
  createDaikinClient,
  type DaikinCapabilities,
  type DaikinClient,
  type DaikinDevice,
  type DaikinDeviceInfo,
  DaikinError,
  type DaikinSensors,
  parseDevice,
} from 'daikin-local-control';

import { type AvailableControls, getAvailableControls } from '../controls.js';
import { getErrorMessage } from '../errors.js';

/** How long, in milliseconds, a setup check waits for the adapter. */
export const probeTimeoutInMs = 5000;

/** What a check of an adapter found. */
export const PROBE_STATUSES = ['ready', 'localPasswordRequired', 'localPasswordRejected', 'registrationRequired', 'registrationRejected', 'unreachable', 'failed'] as const;

export type ProbeStatus = (typeof PROBE_STATUSES)[number];

export interface ProbeCredentials {
  terminalUuid: string;
  /** The child lock code, when the user gave one. */
  localPassword?: string;
}

export interface ProbeResult {
  status: ProbeStatus;
  /** The device with the credentials it turned out to need. */
  device: DaikinDevice;
  /** What the unit accepts, when the status is `ready`. */
  capabilities?: DaikinCapabilities;
  /** What the sensors of the unit read, when the status is `ready`: a reading it gives gets its place in Matter. */
  sensors?: DaikinSensors;
  /** The controls and the switches its device can have in Matter, when the status is `ready`. */
  controls?: AvailableControls;
  /** The adapter's own words for a failure. */
  message?: string;
}

/**
 * Close a setup client without letting a failed close hide the result of the check
 *
 * @param {DaikinClient} client The client to close.
 * @returns {Promise<void>} Resolves when the client is closed or the close failed.
 */
async function closeQuietly(client: DaikinClient): Promise<void> {
  try {
    await client.dispose();
  } catch {
    // The check already has its answer.
  }
}

/**
 * Turn a failed call into what the user has to do next
 *
 * A classic adapter answers `AUTH NG` to a terminal it has not registered and `LPW NG` to a wrong child lock code. Any other
 * rejection is read from what the adapter is known to require.
 *
 * @param {unknown} error The error the call rejected with.
 * @param {DaikinDevice} device The device that was called.
 * @returns {ProbeResult} The status, with the device flagged for the credential it asked for.
 */
function classifyFailure(error: unknown, device: DaikinDevice): ProbeResult {
  const message = getErrorMessage(error);
  if (!(error instanceof DaikinError)) return { status: 'failed', device, message };
  if (error.httpStatusCode === 503 || error.httpStatusCode === 504) return { status: 'unreachable', device, message };
  if (error.httpStatusCode !== 401 && error.httpStatusCode !== 403) return { status: 'failed', device, message };
  const wantsLocalPassword: ProbeResult = { status: 'localPasswordRejected', device: { ...device, requiresLocalPassword: true }, message };
  const wantsRegistration: ProbeResult = { status: 'registrationRequired', device: { ...device, requiresRegistration: true }, message };
  if (message.includes('LPW NG')) return wantsLocalPassword;
  if (message.includes('AUTH NG')) return wantsRegistration;
  // A DSIOT adapter registers no terminal, so the only credential it can reject is the child lock code.
  const takesOnlyLocalPassword = device.protocol === 'dsiot' || (device.requiresLocalPassword === true && device.requiresRegistration !== true);
  return takesOnlyLocalPassword ? wantsLocalPassword : wantsRegistration;
}

/**
 * Check whether an adapter answers this terminal, and read what its unit accepts and what its sensors read when it does
 *
 * @param {DaikinDevice} device The device to check.
 * @param {ProbeCredentials} credentials The terminal uuid and, when given, the child lock code.
 * @returns {Promise<ProbeResult>} `ready` with the capabilities and the device with its name and its MAC address, or the credential or the failure that stands in the way.
 */
export async function probeDevice(device: DaikinDevice, credentials: ProbeCredentials): Promise<ProbeResult> {
  if (device.requiresLocalPassword === true && credentials.localPassword === undefined) return { status: 'localPasswordRequired', device };
  const client = createDaikinClient(device, { ...credentials, timeoutInMs: probeTimeoutInMs });
  try {
    const capabilities = await client.getCapabilities();
    const sensors = await client.getSensors();
    // An adapter added by address, or one that only answers a registered terminal, has not said its name or which
    // adapter it is yet. What the adapter says wins over a name that was typed for it meanwhile.
    const info: DaikinDeviceInfo = device.macAddress === undefined || device.name === undefined ? await client.getDeviceInfo() : {};
    const name = info.name === undefined || info.name === '' ? device.name : info.name;
    return {
      status: 'ready',
      device: { ...device, name, macAddress: info.macAddress ?? device.macAddress, firmwareVersion: info.firmwareVersion ?? device.firmwareVersion },
      capabilities,
      sensors,
      controls: getAvailableControls(capabilities),
    };
  } catch (error) {
    return classifyFailure(error, device);
  } finally {
    await closeQuietly(client);
  }
}

/**
 * Register this terminal with a classic adapter, then check the adapter again
 *
 * @param {DaikinDevice} device The device to register with.
 * @param {string} key The KEY printed on the adapter's label.
 * @param {ProbeCredentials} credentials The terminal uuid and, when given, the child lock code.
 * @returns {Promise<ProbeResult>} The result of the check that follows, or `registrationRejected` when the adapter refused the KEY.
 */
export async function registerWithDevice(device: DaikinDevice, key: string, credentials: ProbeCredentials): Promise<ProbeResult> {
  const client = createDaikinClient(device, { ...credentials, timeoutInMs: probeTimeoutInMs });
  try {
    if (!(client instanceof ClassicDaikinClient)) return { status: 'failed', device, message: 'Only a classic adapter registers terminals' };
    await client.registerTerminal(key);
  } catch (error) {
    const failure = classifyFailure(error, device);
    return failure.status === 'unreachable' || failure.status === 'localPasswordRejected' ? failure : { ...failure, status: 'registrationRejected' };
  } finally {
    await closeQuietly(client);
  }
  return probeDevice(device, credentials);
}

/**
 * Ask a classic adapter who it is over one scheme
 *
 * @param {string} host The address to ask.
 * @param {boolean} usesHttps Whether to ask over HTTPS.
 * @param {string} terminalUuid The terminal uuid.
 * @returns {Promise<DaikinDevice | number>} The device, or the status of the failure: 503 or 504 when nothing answered.
 */
async function identifyClassic(host: string, usesHttps: boolean, terminalUuid: string): Promise<DaikinDevice | number> {
  const client = createDaikinClient({ host, protocol: 'classic', usesHttps }, { terminalUuid, timeoutInMs: probeTimeoutInMs, retry: { delaysInMs: [] } });
  try {
    if (!(client instanceof ClassicDaikinClient)) return 502;
    const device = parseDevice(host, await client.command('/common/basic_info'));
    // A port the user typed wins over the one the adapter announces.
    return host.includes(':') ? { ...device, host } : device;
  } catch (error) {
    const status = error instanceof DaikinError ? error.httpStatusCode : 502;
    // The adapter answered, but only to a terminal it knows.
    if (status === 401 || status === 403) return { host, protocol: 'classic', usesHttps, requiresRegistration: true };
    return status;
  } finally {
    await closeQuietly(client);
  }
}

/**
 * Ask an Airbase adapter whether it is one
 *
 * An Airbase adapter takes no terminal uuid, no registration and no child lock code, so any failure means it is not one.
 *
 * @param {string} host The address to ask.
 * @param {string} terminalUuid The terminal uuid, which the client is built with and does not send.
 * @returns {Promise<DaikinDevice | undefined>} The device with its name and its MAC address, or undefined when the address does not answer as an Airbase adapter.
 */
async function identifyAirbase(host: string, terminalUuid: string): Promise<DaikinDevice | undefined> {
  const client = createDaikinClient({ host, protocol: 'airbase' }, { terminalUuid, timeoutInMs: probeTimeoutInMs, retry: { delaysInMs: [] } });
  try {
    return { host, protocol: 'airbase', ...(await client.getDeviceInfo()) };
  } catch {
    return undefined;
  } finally {
    await closeQuietly(client);
  }
}

/**
 * Ask a DSIOT adapter whether it is one
 *
 * @param {string} host The address to ask.
 * @param {string} terminalUuid The terminal uuid.
 * @returns {Promise<DaikinDevice | undefined>} The device with its name and its MAC address, or undefined when the address does not answer as a DSIOT adapter.
 */
async function identifyDsiot(host: string, terminalUuid: string): Promise<DaikinDevice | undefined> {
  const client = createDaikinClient({ host, protocol: 'dsiot' }, { terminalUuid, timeoutInMs: probeTimeoutInMs, retry: { delaysInMs: [] } });
  try {
    return { host, protocol: 'dsiot', ...(await client.getDeviceInfo()) };
  } catch (error) {
    return error instanceof DaikinError && error.httpStatusCode === 401 ? { host, protocol: 'dsiot', requiresLocalPassword: true } : undefined;
  } finally {
    await closeQuietly(client);
  }
}

/**
 * Find out what answers at an address the user typed, for a device that discovery does not reach
 *
 * It asks as a classic adapter over HTTP, and over HTTPS when nothing answered. An Airbase adapter answers HTTP 404 where
 * a classic adapter answers, so an address that did is asked as an Airbase adapter. It asks as a DSIOT adapter last.
 *
 * @param {string} host The address, with `:port` when the adapter does not use the default one.
 * @param {string} terminalUuid The terminal uuid.
 * @returns {Promise<DaikinDevice | undefined>} The device, named when the adapter told its name, or undefined when no adapter answered.
 */
export async function identifyHost(host: string, terminalUuid: string): Promise<DaikinDevice | undefined> {
  const overHttp = await identifyClassic(host, false, terminalUuid);
  if (typeof overHttp !== 'number') return overHttp;
  if (overHttp === 503 || overHttp === 504) {
    const overHttps = await identifyClassic(host, true, terminalUuid);
    if (typeof overHttps !== 'number') return overHttps;
  }
  if (overHttp === 404) {
    const airbase = await identifyAirbase(host, terminalUuid);
    if (airbase !== undefined) return airbase;
  }
  return identifyDsiot(host, terminalUuid);
}
