/**
 * @file src/module.ts
 * @description This file contains the Matterbridge platform for Daikin air conditioners controlled over the local network.
 * @author Calvin Che
 * @contributor Luca Liguori
 * @created 2026-10-12
 * @version 1.1.0
 * @license Apache-2.0
 *
 * Copyright 2026 Calvin Che.
 * Copyright 2025, 2026 Luca Liguori, for the platform scaffolding from the Matterbridge plugin template.
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

import { randomUUID } from 'node:crypto';

import { createDaikinClient, type DaikinCapabilities, type DaikinClient, type DaikinDevice, type DaikinSensors, discoverDevices } from 'daikin-local-control';
import { MatterbridgeDynamicPlatform, type MatterbridgeEndpoint, type PlatformConfig, type PlatformMatterbridge } from 'matterbridge';
import type { AnsiLogger, LogLevel } from 'matterbridge/logger';

import { DaikinAccessory } from './accessory/daikinAccessory.js';
import type { EndpointNumbers } from './accessory/endpoints.js';
import {
  type DaikinDeviceConfig,
  type DaikinPlatformConfig,
  getUnreadableDevices,
  hasSameConnection,
  hasSameExposure,
  normalizeMacAddress,
  normalizeMaxStateAgeForCommand,
  normalizePollInterval,
  normalizeTerminalUuid,
  parseDeviceConfigs,
  toDaikinDevice,
} from './config.js';
import { addReportedSensors, fitToCapabilities, getAvailableControls, hasSameControls, noReportedSensors, type ReportedSensors } from './controls.js';
import { getErrorMessage } from './errors.js';
import { CapabilityStore } from './platform/capabilityStore.js';
import { getDiscoveredUpdate } from './platform/discovery.js';
import { parseSetupRevision, SetupRevisions } from './platform/setupRevisions.js';
import { identifyHost, probeDevice, type ProbeResult, registerWithDevice } from './setup/probe.js';
import { type DiscoveredDevice, handleSetupRequest, type SetupDevice, type SetupPlatform, type SetupState } from './setup/setupApi.js';

/** How often, in milliseconds, the network is searched to keep the device addresses up to date. */
export const discoveryIntervalInMs = 5 * 60 * 1000;

/** How long, in milliseconds, a read or a command waits for an adapter. */
export const deviceTimeoutInMs = 5000;

const requiredMatterbridgeVersion = '3.10.10';

export type { DaikinPlatformConfig } from './config.js';

/**
 * This is the standard interface for Matterbridge plugins.
 * Each plugin should export a default function that follows this signature.
 *
 * @param {PlatformMatterbridge} matterbridge - An instance of MatterBridge.
 * @param {AnsiLogger} log - An instance of AnsiLogger. This is used for logging messages in a format that can be displayed with ANSI color codes and in the frontend.
 * @param {DaikinPlatformConfig} config - The platform configuration.
 * @returns {DaikinPlatform} - An instance of the MatterbridgeAccessory or MatterbridgeDynamicPlatform class. This is the main interface for interacting with the Matterbridge system.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: DaikinPlatformConfig): DaikinPlatform {
  return new DaikinPlatform(matterbridge, log, config);
}

/**
 * The platform: it stores the devices by the MAC address of their adapter, keeps their addresses up to date, exposes each one to Matter and serves the
 * guided setup.
 */
export class DaikinPlatform extends MatterbridgeDynamicPlatform implements SetupPlatform {
  private devices: DaikinDeviceConfig[];
  /** The stored devices this version cannot read, which are stored again as they are. */
  private unreadableDevices: unknown[];
  /** The running devices, by the MAC address of their adapter. */
  private readonly accessories = new Map<string, DaikinAccessory>();
  private readonly capabilityStore = new CapabilityStore(() => this.context);
  /** Why a stored device is not running, by the MAC address of its adapter. */
  private readonly startErrors = new Map<string, string>();
  /** What the last successful setup check read, by the MAC address of the adapter, until the device is stored. */
  private readonly probedCapabilities = new Map<string, DaikinCapabilities>();
  /** What the sensors of the unit read at that check. */
  private readonly probedSensors = new Map<string, DaikinSensors>();
  /** The devices whose unit was asked what it accepts since the plugin started, by the MAC address of their adapter. */
  private readonly checkedCapabilities = new Set<string>();
  private pollTimer: NodeJS.Timeout | undefined;
  private discoveryTimer: NodeJS.Timeout | undefined;
  private pollIntervalInSeconds: number;
  private maxStateAgeForCommandInSeconds: number;
  private terminalUuid: string | undefined;
  private readonly revisions: SetupRevisions;
  /** The devices whose unit is being read, so that a unit that is slow to answer holds up no other. */
  private readonly polling = new Set<DaikinAccessory>();
  private discovery: Promise<DaikinDevice[]> | undefined;
  // Changes to the device list run one after the other.
  private changes: Promise<void> = Promise.resolve();

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: DaikinPlatformConfig) {
    // Always call super(matterbridge, log, config)
    super(matterbridge, log, config);

    // Verify that Matterbridge is the correct version
    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion(requiredMatterbridgeVersion)) {
      throw new Error(
        `This plugin requires Matterbridge version >= "${requiredMatterbridgeVersion}". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend.`,
      );
    }

    this.log.info(`Initializing platform ${this.config.name}...`);
    this.devices = parseDeviceConfigs(config.devices, (message) => this.log.warn(message));
    this.unreadableDevices = getUnreadableDevices(config.devices, this.devices);
    this.revisions = new SetupRevisions(config.setupRevision);
    this.pollIntervalInSeconds = normalizePollInterval(config.pollIntervalInSeconds);
    this.maxStateAgeForCommandInSeconds = normalizeMaxStateAgeForCommand(config.maxStateAgeForCommandInSeconds);
    this.log.info(`Platform ${this.config.name} initialized successfully`);
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`Starting platform ${this.config.name} with reason: ${reason ?? 'no reason provided'}...`);

    // Wait for the platform storage, which holds what each unit accepts.
    await this.ready;

    this.getTerminalUuid();
    // The Matter node is offline until the platform is configured: the devices are built and registered, not read.
    for (const device of this.devices) await this.startDevice(device);

    this.log.info(`Platform ${this.config.name} started successfully`);
  }

  override async onConfigure(): Promise<void> {
    // Always call super.onConfigure()
    await super.onConfigure();

    this.log.info(`Configuring platform ${this.config.name}...`);
    // The Matter node is online now: the units are read and written to Matter from here on.
    this.startTimers();
    await this.pollDevices();
    // The stored addresses may be out of date, and the first search takes three seconds: do not hold the start for it.
    void this.updateAddresses();
    this.log.info(`Platform ${this.config.name} configured successfully`);
  }

  // oxlint-disable-next-line typescript/require-await
  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    // Always call super.onShutdown(reason)
    await super.onShutdown(reason);

    this.log.info(`Shutting down platform ${this.config.name} with reason: ${reason ?? 'no reason provided'}...`);

    this.stopTimers();
    await this.changes;
    for (const accessory of this.accessories.values()) await accessory.dispose();
    this.accessories.clear();
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();

    this.log.info(`Platform ${this.config.name} shut down successfully`);
  }

  /**
   * Apply a configuration saved in the Matterbridge config editor
   *
   * The editor changes the poll interval and the terminal uuid. The devices are added, changed and removed in the setup
   * page alone, and the editor does not list them.
   *
   * The editor still holds the whole configuration it loaded with its page, and sends all of it back. Saved after the
   * setup page changed the devices meanwhile, that copy holds the devices of before: it is recognized by its revision,
   * and the devices are stored again as they are.
   *
   * @param {PlatformConfig} config The saved configuration.
   * @returns {Promise<void>} Resolves when the configuration is applied.
   */
  override async onConfigChanged(config: PlatformConfig): Promise<void> {
    if (this.pollTimer === undefined) return;
    // A configuration this plugin stored itself comes back here within moments, with nothing in it to apply.
    const revision = parseSetupRevision(config.setupRevision);
    if (this.revisions.acknowledge(revision)) return;
    const pollIntervalInSeconds = normalizePollInterval(config.pollIntervalInSeconds);
    const maxStateAgeForCommandInSeconds = normalizeMaxStateAgeForCommand(config.maxStateAgeForCommandInSeconds);
    const hasNewPollInterval = pollIntervalInSeconds !== this.pollIntervalInSeconds;
    if (hasNewPollInterval || maxStateAgeForCommandInSeconds !== this.maxStateAgeForCommandInSeconds) {
      this.pollIntervalInSeconds = pollIntervalInSeconds;
      this.maxStateAgeForCommandInSeconds = maxStateAgeForCommandInSeconds;
      if (hasNewPollInterval) this.startTimers();
      // How old a state a command may be built from follows both settings, and is set when a client is created.
      await this.reconnectDevices();
    }
    const terminalUuid = normalizeTerminalUuid(config.terminalUuid);
    if (terminalUuid !== undefined && terminalUuid !== this.terminalUuid) await this.useTerminalUuid(terminalUuid);
    // Stored again when what was saved holds the devices of an older page, or a terminal uuid that is missing, not
    // valid or not in the form the plugin stores.
    if (revision !== this.revisions.current || config.terminalUuid !== this.terminalUuid) this.storeConfig();
  }

  /**
   * Serve the setup page's requests to `/plugins/<plugin name>/api/<path>`
   *
   * @param {string} method The HTTP method.
   * @param {string} [path] The path after `api/`.
   * @param {Record<string, unknown>} [query] The query string parameters.
   * @param {unknown} [body] The parsed JSON body.
   * @returns {Promise<unknown>} The JSON reply, or undefined for a path the plugin does not serve.
   */
  override async onFetch(method: string, path?: string, query?: Record<string, unknown>, body?: unknown): Promise<unknown> {
    return handleSetupRequest(this, method, path, query, body);
  }

  /**
   * Get the terminal uuid, generating and storing one the first time
   *
   * @returns {string} The uuid that identifies this plugin to every adapter.
   */
  getTerminalUuid(): string {
    if (this.terminalUuid !== undefined) return this.terminalUuid;
    this.terminalUuid = normalizeTerminalUuid(this.config.terminalUuid);
    if (this.terminalUuid === undefined) {
      this.terminalUuid = randomUUID().replaceAll('-', '');
      this.log.notice(`Generated the terminal uuid ${this.terminalUuid}`);
    }
    // Stored when it is new, and when it was stored with dashes or in upper case, which the config editor refuses.
    if (this.terminalUuid !== this.config.terminalUuid) this.storeConfig();
    return this.terminalUuid;
  }

  /**
   * Describe the stored devices for the setup page
   *
   * @returns {Promise<SetupState>} Each device without its child lock code, with how it is doing.
   */
  async getSetupState(): Promise<SetupState> {
    const devices: SetupDevice[] = [];
    for (const { localPassword, ...device } of this.devices) {
      const status = this.accessories.get(device.macAddress)?.getStatus();
      const offlineOrStopped = status === undefined ? 'stopped' : 'offline';
      const capabilities = await this.capabilityStore.read(device);
      devices.push({
        ...device,
        hasLocalPassword: localPassword !== undefined,
        status: status?.isReachable === true ? 'online' : offlineOrStopped,
        error: status === undefined ? this.startErrors.get(device.macAddress) : status.lastError,
        capabilities,
        controls: capabilities === undefined ? undefined : getAvailableControls(capabilities),
      });
    }
    return { devices };
  }

  /**
   * Search the network for adapters, for the setup page
   *
   * The search also brings the stored addresses up to date.
   *
   * @returns {Promise<DiscoveredDevice[]>} The adapters that answered, each marked when it is stored already and when it still has to register this plugin.
   * @throws {Error} When the discovery socket fails, for example because UDP port 30000 is taken.
   */
  async discoverForSetup(): Promise<DiscoveredDevice[]> {
    const found = await this.discover();
    await this.applyDiscoveredAddresses(found);
    return Promise.all(
      found.map(async (device) => {
        const isConfigured = this.devices.some((stored) => stored.macAddress === normalizeMacAddress(device.macAddress));
        // An adapter that requires registration may know this plugin already: it is asked, so the page only announces
        // the KEY where it is still needed.
        const needsRegistration = device.requiresRegistration === true && !isConfigured && (await this.probe(device)).status !== 'ready';
        return { ...device, isConfigured, needsRegistration };
      }),
    );
  }

  /**
   * Find out what answers at an address the user typed
   *
   * @param {string} host The address.
   * @returns {Promise<DaikinDevice | undefined>} The device, or undefined when no adapter answered.
   */
  async identify(host: string): Promise<DaikinDevice | undefined> {
    return identifyHost(host, this.getTerminalUuid());
  }

  /**
   * Check whether an adapter answers this plugin
   *
   * @param {DaikinDevice} device The device to check.
   * @param {string} [localPassword] The child lock code. Left out, the code stored for that adapter is used.
   * @returns {Promise<ProbeResult>} `ready`, or the credential or the failure that stands in the way.
   */
  async probe(device: DaikinDevice, localPassword?: string): Promise<ProbeResult> {
    return this.rememberProbe(await probeDevice(device, this.getCredentials(device, localPassword)));
  }

  /**
   * Register this plugin's terminal uuid with a classic adapter
   *
   * @param {DaikinDevice} device The device to register with.
   * @param {string} key The KEY printed on the adapter's label. It is used once and never stored.
   * @param {string} [localPassword] The child lock code. Left out, the code stored for that adapter is used.
   * @returns {Promise<ProbeResult>} The result of the check that follows the registration.
   */
  async register(device: DaikinDevice, key: string, localPassword?: string): Promise<ProbeResult> {
    return this.rememberProbe(await registerWithDevice(device, key, this.getCredentials(device, localPassword)));
  }

  /**
   * Store a device, adding it or replacing the stored device of the same adapter
   *
   * @param {DaikinDeviceConfig} device The device. Without a child lock code, the stored one is kept.
   * @returns {Promise<void>} Resolves when the device is stored and started, restarted or updated.
   * @throws {Error} When another stored device already has the name.
   */
  async saveDevice(device: DaikinDeviceConfig): Promise<void> {
    const stored = this.devices.find((candidate) => candidate.macAddress === device.macAddress);
    if (this.devices.some((candidate) => candidate !== stored && candidate.name === device.name)) throw new Error(`Another air conditioner is already named "${device.name}"`);
    const probed = this.probedCapabilities.get(device.macAddress);
    if (probed !== undefined) {
      await this.capabilityStore.write(device, probed);
      this.probedCapabilities.delete(device.macAddress);
      this.checkedCapabilities.add(device.macAddress);
    }
    const sensors = this.probedSensors.get(device.macAddress);
    if (sensors !== undefined) {
      // A reading the unit gave before still counts, whether or not the check got it.
      await this.capabilityStore.writeSensors(device, addReportedSensors((await this.capabilityStore.readSensors(device)) ?? noReportedSensors, sensors));
      this.probedSensors.delete(device.macAddress);
    }
    const capabilities = probed ?? (await this.capabilityStore.read(device));
    const next = capabilities === undefined ? { ...device } : fitToCapabilities(device, capabilities);
    if (next.requiresLocalPassword && next.localPassword === undefined && stored?.localPassword !== undefined) next.localPassword = stored.localPassword;
    if (!next.requiresLocalPassword) delete next.localPassword;
    const devices = stored === undefined ? [...this.devices, next] : this.devices.map((candidate) => (candidate === stored ? next : candidate));
    // The check that came before this save may have found that the unit accepts other settings than its endpoints show.
    const running = this.accessories.get(device.macAddress);
    const hasNewControls = probed !== undefined && running !== undefined && !hasSameControls(running.capabilities, probed);
    await this.applyDevices(devices, hasNewControls ? device.macAddress : undefined);
  }

  /**
   * Remove a stored device and its Matter endpoints
   *
   * @param {string} macAddress The MAC address of its adapter.
   * @returns {Promise<boolean>} False when no device has that adapter.
   */
  async removeDevice(macAddress: string): Promise<boolean> {
    if (!this.devices.some((device) => device.macAddress === macAddress)) return false;
    await this.applyDevices(this.devices.filter((device) => device.macAddress !== macAddress));
    return true;
  }

  /**
   * Search the network and store the address of each stored device whose adapter answered from a new one
   *
   * A device is matched by the MAC address of its adapter. A failed search is logged, never thrown.
   *
   * @returns {Promise<void>} Resolves when the addresses are up to date, the devices that could not start were retried and the units started from stored capabilities were asked what they accept now.
   */
  async updateAddresses(): Promise<void> {
    try {
      await this.applyDiscoveredAddresses(await this.discover());
    } catch (error) {
      this.log.warn(`The search for Daikin adapters failed: ${getErrorMessage(error)}`);
    }
    try {
      await this.enqueueChange(async () => {
        await this.startStoppedDevices();
        await this.checkCapabilities();
      });
    } catch {
      // enqueueChange logged it.
    }
  }

  /**
   * Read the state of every running device once
   *
   * A device whose unit has not answered the read before this one is left out, so that the others are still read on
   * time.
   *
   * A device that just stopped answering triggers a search, since a changed address is the likeliest cause. A unit that
   * gave a reading its device shows nowhere yet has the device built again in Matter, with a place for it.
   *
   * @returns {Promise<void>} Resolves when every device that was read answered or failed.
   */
  async pollDevices(): Promise<void> {
    const idle = [...this.accessories.values()].filter((accessory) => !this.polling.has(accessory));
    try {
      const results = await Promise.all(
        idle.map(async (accessory) => {
          this.polling.add(accessory);
          try {
            const wasReachable = accessory.getStatus().isReachable;
            await accessory.refresh();
            return wasReachable && !accessory.getStatus().isReachable;
          } finally {
            this.polling.delete(accessory);
          }
        }),
      );
      if (results.includes(true)) void this.updateAddresses();
      await this.enqueueChange(async () => this.exposeNewSensors());
    } catch {
      // enqueueChange logged it.
    }
  }

  private async useTerminalUuid(terminalUuid: string): Promise<void> {
    this.terminalUuid = terminalUuid;
    this.log.notice(`The terminal uuid is now ${terminalUuid}`);
    await this.reconnectDevices();
  }

  private async reconnectDevices(): Promise<void> {
    await this.enqueueChange(async () => {
      for (const device of this.devices) await this.accessories.get(device.macAddress)?.updateConnection(device, this.createClient(device));
    });
  }

  private startTimers(): void {
    this.stopTimers();
    this.pollTimer = setInterval(() => void this.pollDevices(), this.pollIntervalInSeconds * 1000);
    this.pollTimer.unref();
    this.discoveryTimer = setInterval(() => void this.updateAddresses(), discoveryIntervalInMs);
    this.discoveryTimer.unref();
  }

  private stopTimers(): void {
    clearInterval(this.pollTimer);
    clearInterval(this.discoveryTimer);
    this.pollTimer = undefined;
    this.discoveryTimer = undefined;
  }

  private async enqueueChange(task: () => Promise<void>): Promise<void> {
    const result = this.changes.then(task);
    this.changes = result.catch((error: unknown) => {
      this.log.error(`A change to the devices failed: ${getErrorMessage(error)}`);
    });
    return result;
  }

  private getCredentials(device: DaikinDevice, localPassword?: string): { terminalUuid: string; localPassword?: string } {
    const stored = this.devices.find((candidate) => candidate.macAddress === normalizeMacAddress(device.macAddress));
    return { terminalUuid: this.getTerminalUuid(), localPassword: localPassword ?? stored?.localPassword };
  }

  private rememberProbe(result: ProbeResult): ProbeResult {
    const macAddress = normalizeMacAddress(result.device.macAddress);
    if (macAddress !== undefined && result.capabilities !== undefined) this.probedCapabilities.set(macAddress, result.capabilities);
    if (macAddress !== undefined && result.sensors !== undefined) this.probedSensors.set(macAddress, result.sensors);
    return result;
  }

  private createClient(device: DaikinDeviceConfig): DaikinClient {
    return createDaikinClient(toDaikinDevice(device), {
      terminalUuid: this.getTerminalUuid(),
      localPassword: device.localPassword,
      timeoutInMs: deviceTimeoutInMs,
      // The state is polled anyway, so a command is built from the last poll instead of reading the unit again first.
      maxStateAgeForSetStateInMs: Math.min(this.pollIntervalInSeconds, this.maxStateAgeForCommandInSeconds) * 1000,
    });
  }

  private async discover(): Promise<DaikinDevice[]> {
    // Two searches at once would share UDP port 30000 and split the replies between them.
    this.discovery ??= discoverDevices().finally(() => {
      this.discovery = undefined;
    });
    return this.discovery;
  }

  private async applyDiscoveredAddresses(found: DaikinDevice[]): Promise<void> {
    await this.enqueueChange(async () => {
      const devices = this.devices.map((stored) => {
        const updated = getDiscoveredUpdate(stored, found, this.log);
        if (updated === undefined) return stored;
        if (updated.host !== stored.host) this.log.notice(`"${stored.name}" moved from ${stored.host} to ${updated.host}`);
        return updated;
      });
      if (devices.some((device, index) => device !== this.devices[index])) await this.reconcile(devices);
    });
  }

  // Stores the devices and the terminal uuid, under a new revision.
  private storeConfig(): void {
    this.config.setupRevision = this.revisions.advance();
    this.config.terminalUuid = this.getTerminalUuid();
    // A device this version cannot read stays stored, until one with its name or its MAC address takes its place.
    this.unreadableDevices = getUnreadableDevices(this.unreadableDevices, this.devices);
    this.config.devices = [...this.devices, ...this.unreadableDevices];
    this.saveConfig(this.config);
  }

  /**
   * Make the running devices match a new device list
   *
   * @param {DaikinDeviceConfig[]} devices The new list.
   * @param {string} [rebuiltMacAddress] The MAC address of the adapter of a device to build again in Matter even when its configuration is the same.
   * @returns {Promise<void>} Resolves when every device is started, stopped, restarted or updated.
   */
  private async applyDevices(devices: DaikinDeviceConfig[], rebuiltMacAddress?: string): Promise<void> {
    await this.enqueueChange(async () => this.reconcile(devices, rebuiltMacAddress));
  }

  // Runs inside the queue of changes.
  private async reconcile(devices: DaikinDeviceConfig[], rebuiltMacAddress?: string): Promise<void> {
    const previous = this.devices;
    this.devices = devices;
    this.storeConfig();
    for (const device of previous) {
      if (!devices.some((candidate) => candidate.macAddress === device.macAddress)) await this.stopDevice(device, true);
    }
    for (const device of devices) {
      const before = previous.find((candidate) => candidate.macAddress === device.macAddress);
      const accessory = this.accessories.get(device.macAddress);
      if (before === undefined || accessory === undefined) {
        await this.startDevice(device);
      } else if (!hasSameExposure(before, device) || device.macAddress === rebuiltMacAddress) {
        // The clusters of a registered endpoint cannot change, so the endpoints are built again, under their numbers.
        const numbers = await this.stopDevice(before, false);
        await this.startDevice(device, { numbers });
      } else if (hasSameConnection(before, device)) {
        await accessory.updateConfig(device);
      } else {
        await accessory.updateConnection(device, this.createClient(device));
        await accessory.refresh();
      }
    }
  }

  private async startStoppedDevices(): Promise<void> {
    for (const device of this.devices) {
      if (!this.accessories.has(device.macAddress)) await this.startDevice(device);
    }
  }

  /**
   * Create the Matter endpoints of a device and register them
   *
   * A device that cannot start is logged and retried on the next search, never thrown.
   *
   * @param {DaikinDeviceConfig} device The device.
   * @param {{ knownSensors?: ReportedSensors; numbers?: EndpointNumbers }} [options] The readings its unit has given, which the stored ones stand in for, and the endpoint numbers of a device built again, which its endpoints keep.
   * @returns {Promise<void>} Resolves when the device runs, or could not be started.
   */
  private async startDevice(device: DaikinDeviceConfig, options: { knownSensors?: ReportedSensors; numbers?: EndpointNumbers } = {}): Promise<void> {
    const client = this.createClient(device);
    const registered: MatterbridgeEndpoint[] = [];
    try {
      let capabilities = await this.capabilityStore.read(device);
      if (capabilities === undefined) {
        capabilities = await client.getCapabilities();
        await this.capabilityStore.write(device, capabilities);
        this.checkedCapabilities.add(device.macAddress);
      }
      const reportedSensors = options.knownSensors ?? (await this.capabilityStore.readSensors(device)) ?? noReportedSensors;
      const accessory = new DaikinAccessory({
        config: device,
        capabilities,
        reportedSensors,
        client,
        log: this.log,
        vendorId: this.matterbridge.aggregatorVendorId,
        numbers: options.numbers,
      });
      for (const endpoint of accessory.endpoints) {
        await this.registerDevice(endpoint);
        registered.push(endpoint);
      }
      await accessory.clearReadings();
      this.accessories.set(device.macAddress, accessory);
      this.startErrors.delete(device.macAddress);
      this.log.info(`"${device.name}" started at ${device.host} with ${accessory.endpoints.length} Matter endpoint(s)`);
      // Not awaited: a unit that does not answer must not hold up the start of the others. Before the platform is
      // configured the Matter node is offline, and the first poll reads every device once it is.
      if (this.pollTimer !== undefined) void accessory.refresh();
    } catch (error) {
      const message = getErrorMessage(error);
      if (this.startErrors.get(device.macAddress) !== message) this.log.warn(`"${device.name}" could not be started at ${device.host} and will be retried: ${message}`);
      this.startErrors.set(device.macAddress, message);
      for (const endpoint of registered) await this.unregisterDevice(endpoint);
      try {
        await client.dispose();
      } catch {
        // The start already failed for another reason.
      }
    }
  }

  /**
   * Build again in Matter each device whose unit gave a reading it shows nowhere yet
   *
   * Runs inside the queue of changes.
   *
   * @returns {Promise<void>} Resolves when every such device has a place for the reading.
   */
  private async exposeNewSensors(): Promise<void> {
    for (const device of this.devices) {
      const reported = this.accessories.get(device.macAddress)?.getNewlyReportedSensors();
      if (reported === undefined) continue;
      this.log.notice(`"${device.name}" gave a reading it shows nowhere in Matter yet: it is built again in Matter`);
      await this.capabilityStore.writeSensors(device, reported);
      const numbers = await this.stopDevice(device, false);
      await this.startDevice(device, { knownSensors: reported, numbers });
    }
  }

  /**
   * Stop a device and take its Matter endpoints away
   *
   * @param {DaikinDeviceConfig} device The device.
   * @param {boolean} shouldForget Whether to forget what is known about its unit too, for a device that is removed.
   * @returns {Promise<EndpointNumbers | undefined>} The endpoint numbers the device had, for a device built again, or undefined when it was not running.
   */
  private async stopDevice(device: DaikinDeviceConfig, shouldForget: boolean): Promise<EndpointNumbers | undefined> {
    const { name, macAddress } = device;
    const accessory = this.accessories.get(macAddress);
    this.accessories.delete(macAddress);
    this.startErrors.delete(macAddress);
    let numbers: EndpointNumbers | undefined;
    if (accessory !== undefined) {
      numbers = accessory.getEndpointNumbers();
      await accessory.dispose();
      for (const endpoint of accessory.endpoints) await this.unregisterDevice(endpoint);
      this.log.info(`"${name}" stopped`);
    }
    if (shouldForget) {
      this.checkedCapabilities.delete(macAddress);
      await this.capabilityStore.remove(device);
    }
    return numbers;
  }

  /**
   * Ask each unit that was started from stored capabilities what it accepts now, once after each start
   *
   * A unit answers differently after its firmware or this plugin's Daikin library changed. When the difference changes
   * its controls, the device is built again in Matter and the settings the unit no longer takes are dropped.
   *
   * @returns {Promise<void>} Resolves when every unit that answers was asked. A unit that does not is asked on the next search.
   */
  private async checkCapabilities(): Promise<void> {
    for (const device of this.devices) {
      const accessory = this.accessories.get(device.macAddress);
      if (accessory === undefined || this.checkedCapabilities.has(device.macAddress) || !accessory.getStatus().isReachable) continue;
      let capabilities: DaikinCapabilities;
      try {
        capabilities = await accessory.readCapabilities();
      } catch {
        continue;
      }
      this.checkedCapabilities.add(device.macAddress);
      await this.capabilityStore.write(device, capabilities);
      if (hasSameControls(accessory.capabilities, capabilities)) continue;
      this.log.notice(`"${device.name}" accepts other settings than when it was set up: it is built again in Matter`);
      const fitted = fitToCapabilities(device, capabilities);
      this.devices = this.devices.map((candidate) => (candidate.macAddress === device.macAddress ? fitted : candidate));
      this.storeConfig();
      const numbers = await this.stopDevice(device, false);
      await this.startDevice(fitted, { numbers });
    }
  }
}
