/**
 * @file src/setup/setupApi.ts
 * @description This file contains the REST API the setup page calls through the platform's onFetch: what it sends and takes, and its handler.
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

import { DAIKIN_PROTOCOLS, type DaikinCapabilities, type DaikinDevice } from 'daikin-local-control';
import { isValidObject, isValidString } from 'matterbridge/utils';

import { type DaikinDeviceConfig, isValidHost, normalizeDeviceName, normalizeMacAddress, parseDeviceConfig } from '../config.js';
import type { AvailableControls } from '../controls.js';
import { getErrorMessage } from '../errors.js';
import type { ProbeResult } from './probe.js';

/** A stored device as the setup page sees it: without its child lock code, with how it is doing. */
export type SetupDevice = Omit<DaikinDeviceConfig, 'localPassword'> & {
  hasLocalPassword: boolean;
  /** `online` and `offline` for a running device, `stopped` for one that could not be started yet. */
  status: 'online' | 'offline' | 'stopped';
  error?: string;
  capabilities?: DaikinCapabilities;
  /** The controls and the switches the device can have in Matter, for a device whose capabilities are known. */
  controls?: AvailableControls;
};

export interface SetupState {
  devices: SetupDevice[];
}

/** An adapter found on the network, as the setup page sees it. */
export type DiscoveredDevice = DaikinDevice & {
  /** The adapter is that of a stored device. */
  isConfigured: boolean;
  /** Another adapter answered with the same name, so the two cannot be told apart. */
  hasDuplicateName: boolean;
  /** The adapter only answers registered terminals, and does not answer this plugin's yet. */
  needsRegistration: boolean;
};

/** What each request carries back when it worked, by its method and its path. The setup page reads its replies by it. */
export interface SetupReplies {
  'GET state': { state: SetupState };
  'POST discover': { devices: DiscoveredDevice[] };
  'POST identify': { device: DaikinDevice };
  'POST probe': { result: ProbeResult };
  'POST register': { result: ProbeResult };
  'POST device': { state: SetupState };
  /** Nothing but that it worked. Matterbridge answers a DELETE with 204 and no body. */
  'DELETE device': object;
}

/** Every reply says whether the request worked, so the page never has to read an HTTP status. */
export type SetupReply = ({ ok: true } & SetupReplies[keyof SetupReplies]) | { ok: false; error: string };

/** The part of the platform the setup page reaches. */
export interface SetupPlatform {
  getSetupState: () => Promise<SetupState>;
  discoverForSetup: () => Promise<DiscoveredDevice[]>;
  identify: (host: string) => Promise<DaikinDevice | undefined>;
  probe: (device: DaikinDevice, localPassword?: string) => Promise<ProbeResult>;
  register: (device: DaikinDevice, key: string, localPassword?: string) => Promise<ProbeResult>;
  saveDevice: (device: DaikinDeviceConfig) => Promise<void>;
  removeDevice: (name: string) => Promise<boolean>;
}

const maxSecretLength = 64;

/**
 * Build the reply of a request that could not be served
 *
 * @param {string} error What was wrong, in words the page can show.
 * @returns {SetupReply} The failed reply.
 */
function fail(error: string): SetupReply {
  return { ok: false, error };
}

/**
 * Read a request body as a record
 *
 * @param {unknown} body The parsed JSON body.
 * @returns {Record<string, unknown>} The body, or an empty record when it is not an object.
 */
function toRecord(body: unknown): Record<string, unknown> {
  return isValidObject(body) ? { ...body } : {};
}

/**
 * Read an optional secret, such as the child lock code
 *
 * @param {unknown} value The value from the request.
 * @returns {string | undefined} The secret, or undefined when none was sent.
 */
function parseSecret(value: unknown): string | undefined {
  return isValidString(value, 1, maxSecretLength) ? value : undefined;
}

/**
 * Read the adapter a request is about
 *
 * @param {unknown} value The value from the request.
 * @returns {DaikinDevice | undefined} The device, or undefined when its address or its protocol is not valid.
 */
export function parseDaikinDevice(value: unknown): DaikinDevice | undefined {
  const raw = toRecord(value);
  const protocol = DAIKIN_PROTOCOLS.find((candidate) => candidate === raw.protocol);
  if (!isValidHost(raw.host) || protocol === undefined) return undefined;
  return {
    host: raw.host,
    protocol,
    name: normalizeDeviceName(raw.name),
    macAddress: normalizeMacAddress(raw.macAddress),
    requiresRegistration: raw.requiresRegistration === true,
    usesHttps: raw.usesHttps === true,
    requiresLocalPassword: raw.requiresLocalPassword === true,
  };
}

/**
 * Serve one POST request of the setup page
 *
 * @param {SetupPlatform} platform The platform.
 * @param {string} path The path after `api/`.
 * @param {Record<string, unknown>} body The request body.
 * @returns {Promise<SetupReply | undefined>} The reply, or undefined for a path that is not served.
 */
async function handlePost(platform: SetupPlatform, path: string, body: Record<string, unknown>): Promise<SetupReply | undefined> {
  if (path === 'discover') return { ok: true, devices: await platform.discoverForSetup() };
  if (path === 'identify') {
    if (!isValidHost(body.host)) return fail('Enter an IP address or a host name, without http:// and without a path');
    const device = await platform.identify(body.host);
    return device === undefined ? fail(`No Daikin adapter answered at ${body.host}`) : { ok: true, device };
  }
  if (path === 'probe' || path === 'register') {
    const device = parseDaikinDevice(body.device);
    if (device === undefined) return fail('The device has no valid address or protocol');
    const localPassword = parseSecret(body.localPassword);
    if (path === 'probe') return { ok: true, result: await platform.probe(device, localPassword) };
    const key = parseSecret(body.key);
    return key === undefined ? fail('Enter the KEY printed on the adapter') : { ok: true, result: await platform.register(device, key, localPassword) };
  }
  if (path === 'device') {
    const device = parseDeviceConfig(body.device);
    // The MAC address is what the plugin knows the adapter by: the Connect step reads it from the adapter.
    if (device === undefined) return fail('The device needs a name of at most 32 characters, a valid address and the MAC address of its adapter, which an adapter may not report');
    await platform.saveDevice(device);
    return { ok: true, state: await platform.getSetupState() };
  }
  return undefined;
}

/**
 * Serve one request of the setup page
 *
 * Paths: `GET state`, `POST discover`, `POST identify`, `POST probe`, `POST register`, `POST device` and
 * `DELETE device?name=`. A child lock code or a KEY is accepted, never returned.
 *
 * Edge cases:
 *  - a path that is not served -> undefined, which Matterbridge answers with 404
 *  - a request that fails -> `{ ok: false, error }`, never a thrown error
 *
 * @param {SetupPlatform} platform The platform.
 * @param {string} method The HTTP method.
 * @param {string} [path] The path after `api/`.
 * @param {Record<string, unknown>} [query] The query string parameters.
 * @param {unknown} [body] The parsed JSON body.
 * @returns {Promise<SetupReply | undefined>} The reply.
 */
export async function handleSetupRequest(platform: SetupPlatform, method: string, path?: string, query?: Record<string, unknown>, body?: unknown): Promise<SetupReply | undefined> {
  try {
    if (method === 'GET' && path === 'state') return { ok: true, state: await platform.getSetupState() };
    if (method === 'POST' && path !== undefined) return await handlePost(platform, path, toRecord(body));
    if (method === 'DELETE' && path === 'device') {
      const name = normalizeDeviceName(query?.name);
      if (name === undefined) return fail('Name the device to remove');
      return (await platform.removeDevice(name)) ? { ok: true } : fail(`No device is named "${name}"`);
    }
    return undefined;
  } catch (error) {
    return fail(getErrorMessage(error));
  }
}
