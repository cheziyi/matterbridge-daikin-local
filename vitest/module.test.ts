/**
 * @file vitest/module.test.ts
 * @description This file contains the tests for the Daikin platform.
 * @author Calvin Che
 */

/* oxlint-disable unicorn/no-useless-undefined */

/**
 * WARNING!!!
 * The tests in this unit are supposed to run sequentially because they depend on the Matterbridge/Matter state.
 * Is not possible for timing reasons to create and destroy a Matter node each test to keep isolation.
 */

import { createDaikinClient, type DaikinDevice, DaikinError, discoverDevices } from 'daikin-local-control';
import type { MatterbridgeEndpoint, PlatformConfig } from 'matterbridge';
import { LogLevel } from 'matterbridge/logger';
import { OnOff, RelativeHumidityMeasurement, TemperatureMeasurement } from 'matterbridge/matter/clusters';
import { log, setupTest } from 'matterbridge/vitest-utils';
import { addMatterbridge, createServerNode, createTestEnvironment, getMatterbridge, startServerNode, stopServerNode } from 'matterbridge/vitest-utils/matter';

import type { DaikinDeviceConfig } from '../src/config.js';
import initializePlugin, { DaikinPlatform, type DaikinPlatformConfig, discoveryIntervalInMs } from '../src/module.js';
import { identifyHost, probeDevice, type ProbeResult, registerWithDevice } from '../src/setup/probe.js';
import { createCapabilities, createDeviceConfig, createFakeClient, type FakeClient, macOf } from './fakeDaikin.js';

vi.mock('daikin-local-control', async (importOriginal) => ({
  ...(await importOriginal<typeof import('daikin-local-control')>()),
  createDaikinClient: vi.fn(),
  discoverDevices: vi.fn(),
}));

vi.mock('../src/setup/probe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/setup/probe.js')>()),
  probeDevice: vi.fn(),
  registerWithDevice: vi.fn(),
  identifyHost: vi.fn(),
}));

const createClient = vi.mocked(createDaikinClient);
const discover = vi.mocked(discoverDevices);
const pluginName = 'matterbridge-daikin-local';
const livingRoom = createDeviceConfig();
const bedroom = createDeviceConfig({ name: 'Bedroom', host: '192.168.1.51', fanControl: 'hidden', swingControl: 'hidden' });

// One fake unit for each address, as on a network.
const units = new Map<string, FakeClient>();

/**
 * Get the fake unit at an address, creating it the first time
 *
 * @param {string} host The address.
 * @returns {FakeClient} The unit.
 */
function unitAt(host: string): FakeClient {
  let unit = units.get(host);
  if (unit === undefined) {
    unit = createFakeClient();
    units.set(host, unit);
  }
  return unit;
}

/**
 * Build the platform configuration
 *
 * @param {Partial<DaikinPlatformConfig>} overrides The fields to replace.
 * @returns {DaikinPlatformConfig} The configuration.
 */
function createConfig(overrides: Partial<DaikinPlatformConfig> = {}): DaikinPlatformConfig {
  return { name: pluginName, type: 'DynamicPlatform', version: '0.1.0', debug: false, unregisterOnShutdown: false, ...overrides };
}

/**
 * Describe an adapter as a search finds it
 *
 * @param {Partial<DaikinDevice>} overrides The fields to replace.
 * @returns {DaikinDevice} The adapter.
 */
function found(overrides: Partial<DaikinDevice> = {}): DaikinDevice {
  // The adapter of a unit keeps its MAC address, whatever its address and its name are now.
  const name = 'name' in overrides ? overrides.name : 'Living Room';
  const macAddress = macOf(name ?? overrides.host ?? 'nameless');
  return { host: '192.168.1.50', protocol: 'classic', name: 'Living Room', macAddress, requiresRegistration: false, usesHttps: false, requiresLocalPassword: false, ...overrides };
}

await setupTest('DaikinPlatform', false);

describe('DaikinPlatform', () => {
  const matterbridge = { ...getMatterbridge(), bridgeMode: 'bridge' as const };
  const saveConfig = vi.spyOn(DaikinPlatform.prototype, 'saveConfig').mockImplementation(() => undefined);
  // The callbacks of the platform timers by period, so a test can fire one without waiting for it.
  const timers = new Map<number, () => void>();
  const startInterval = globalThis.setInterval;
  const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, periodInMs?: number) => {
    timers.set(periodInMs ?? 0, callback);
    return startInterval(callback, periodInMs);
  }) as typeof setInterval);
  let platform: DaikinPlatform;
  let editorClock = Date.now();

  /**
   * Find the callback of the platform timer with a given period
   *
   * @param {number} periodInMs The period of the timer.
   * @returns {() => void} The callback of the timer started last.
   */
  function timerCallback(periodInMs: number): () => void {
    const callback = timers.get(periodInMs);
    if (callback === undefined) throw new Error(`No timer runs every ${periodInMs} ms`);
    return callback;
  }

  /**
   * Wait until the queued changes and reads of the platform are done
   *
   * @returns {Promise<void>} Resolves after the pending work.
   */
  async function settle(): Promise<void> {
    await platform.updateAddresses();
    await platform.pollDevices();
  }

  beforeAll(async () => {
    await createTestEnvironment();
    await createServerNode(6102);
    await startServerNode();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    createClient.mockImplementation((device) => unitAt(device.host));
    discover.mockResolvedValue([]);
  });

  afterAll(async () => {
    await stopServerNode();
    vi.restoreAllMocks();
  });

  it('should throw an error if matterbridge is not the required version', () => {
    expect(() => new DaikinPlatform({ ...matterbridge, matterbridgeVersion: '2.0.0' }, log, createConfig())).toThrow(
      'This plugin requires Matterbridge version >= "3.10.10". Please update Matterbridge from 2.0.0 to the latest version in the frontend.',
    );
  });

  it('should create the platform and report stored devices that are not valid', () => {
    // The last one has no MAC address, and the name of a device that is valid.
    const config = createConfig({ devices: [livingRoom, { ...livingRoom, host: '192.168.1.99' }, { name: 'Living Room' }], pollIntervalInSeconds: 20 });
    platform = initializePlugin(matterbridge, log, config);
    expect(platform).toBeInstanceOf(DaikinPlatform);
    addMatterbridge(platform);
    expect(log.info).toHaveBeenCalledWith(`Initializing platform ${pluginName}...`);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('should ignore a saved configuration before it is started', async () => {
    await platform.onConfigChanged(createConfig({ devices: [] }));
    expect(platform.getDevices()).toHaveLength(0);
  });

  it('should generate a terminal uuid, start the stored devices and search for their addresses', async () => {
    await platform.onStart('Vitest');
    expect(log.info).toHaveBeenCalledWith(`Starting platform ${pluginName} with reason: Vitest...`);
    expect(log.notice).toHaveBeenCalledWith(expect.stringContaining('Generated the terminal uuid'));
    expect(platform.config.terminalUuid).toMatch(/^[0-9a-f]{32}$/);
    expect(saveConfig).toHaveBeenCalledWith(platform.config);
    // Neither stored device that was not valid is stored again: the valid one has their name.
    expect(platform.config.devices).toEqual([livingRoom]);
    // The air conditioner and its two swing switches.
    expect(platform.getDevices()).toHaveLength(3);
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ host: '192.168.1.50', name: 'Living Room', macAddress: macOf('Living Room') }), {
      terminalUuid: platform.config.terminalUuid,
      localPassword: undefined,
      timeoutInMs: 5000,
      // A command is built from a poll no older than the poll interval of 20 seconds.
      maxStateAgeForSetStateInMs: 20_000,
    });
    expect(unitAt('192.168.1.50').getCapabilities).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(unitAt('192.168.1.50').getState).toHaveBeenCalled());
    await settle();
  });

  it('should read the state of every device when it is configured and on each poll', async () => {
    await platform.onConfigure();
    expect(log.info).toHaveBeenCalledWith(`Configuring platform ${pluginName}...`);
    expect(unitAt('192.168.1.50').getState).toHaveBeenCalledTimes(1);
    expect(platform.getDeviceByName('Living Room')?.getAttribute(OnOff, 'onOff')).toBe(true);

    timerCallback(20_000)();
    await vi.waitFor(() => expect(unitAt('192.168.1.50').getState).toHaveBeenCalledTimes(2));
    await settle();
  });

  it('should read each device once when two polls overlap', async () => {
    await Promise.all([platform.pollDevices(), platform.pollDevices()]);
    expect(unitAt('192.168.1.50').getState).toHaveBeenCalledTimes(1);
  });

  it('should keep reading the other devices while one unit is slow to answer', async () => {
    await platform.saveDevice(createDeviceConfig({ name: 'Lobby', host: '192.168.1.90', fanControl: 'hidden', swingControl: 'hidden' }));
    await settle();
    vi.clearAllMocks();
    const slow = unitAt('192.168.1.50');
    const lobby = unitAt('192.168.1.90');
    let answer = (): void => undefined;
    slow.getStateAndSensors.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          answer = (): void => resolve({ state: { ...slow.state }, sensors: { ...slow.sensors } });
        }),
    );
    const held = platform.pollDevices();
    await vi.waitFor(() => expect(lobby.getStateAndSensors).toHaveBeenCalledTimes(1));
    // The living room unit has not answered yet: the next poll reads the lobby again, and leaves the living room alone.
    await platform.pollDevices();
    expect(lobby.getStateAndSensors).toHaveBeenCalledTimes(2);
    expect(slow.getStateAndSensors).toHaveBeenCalledTimes(1);
    answer();
    await held;
    await platform.pollDevices();
    expect(slow.getStateAndSensors).toHaveBeenCalledTimes(2);
    expect(await platform.removeDevice(macOf('Lobby'))).toBe(true);
  });

  it('should describe the stored devices without their child lock code', async () => {
    const state = await platform.getSetupState();
    expect(state.devices).toHaveLength(1);
    expect(state.devices[0]).toMatchObject({
      name: 'Living Room',
      host: '192.168.1.50',
      status: 'online',
      hasLocalPassword: false,
      capabilities: { swingModes: ['off', 'vertical', 'horizontal', 'both'] },
      controls: { hasSwing: true, hasFanAuto: true, specialModes: [] },
    });
    expect(state.devices[0]).not.toHaveProperty('localPassword');
    expect(await platform.onFetch('GET', 'state')).toEqual({ ok: true, state });
  });

  it('should follow a device to its new address when a search finds its adapter elsewhere', async () => {
    discover.mockResolvedValueOnce([found({ host: '192.168.1.77' }), found({ name: 'Kitchen', host: '192.168.1.60' }), found({ name: undefined, host: '192.168.1.61' })]);
    timerCallback(discoveryIntervalInMs)();
    await vi.waitFor(() => expect(log.notice).toHaveBeenCalledWith('"Living Room" moved from 192.168.1.50 to 192.168.1.77'));
    await settle();
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ devices: [expect.objectContaining({ name: 'Living Room', host: '192.168.1.77' })] }));
    expect(unitAt('192.168.1.50').dispose).toHaveBeenCalled();
    expect(unitAt('192.168.1.77').getState).toHaveBeenCalled();
    expect(platform.getDevices()).toHaveLength(3);
  });

  it('should mark what a search for the setup page found', async () => {
    discover.mockResolvedValueOnce([
      found({ host: '192.168.1.77' }),
      found({ name: 'Kitchen', host: '192.168.1.60' }),
      found({ name: 'Kitchen', host: '192.168.1.62' }),
      found({ name: undefined, host: '192.168.1.61' }),
    ]);
    expect(await platform.discoverForSetup()).toEqual([
      expect.objectContaining({ name: 'Living Room', isConfigured: true, needsRegistration: false }),
      // Two adapters with one name are each offered: each device gets a name of its own in the setup page.
      expect.objectContaining({ host: '192.168.1.60', isConfigured: false }),
      expect.objectContaining({ host: '192.168.1.62', isConfigured: false }),
      expect.objectContaining({ host: '192.168.1.61', isConfigured: false }),
    ]);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('should tell whether an adapter that requires registration answers this plugin already', async () => {
    const kitchen = found({ name: 'Kitchen', host: '192.168.1.60', requiresRegistration: true });
    const attic = found({ name: 'Attic', host: '192.168.1.63', requiresRegistration: true });
    discover.mockResolvedValueOnce([kitchen, attic]);
    vi.mocked(probeDevice)
      .mockResolvedValueOnce({ status: 'ready', device: kitchen, capabilities: createCapabilities() })
      .mockResolvedValueOnce({ status: 'registrationRequired', device: attic });
    expect(await platform.discoverForSetup()).toEqual([
      expect.objectContaining({ name: 'Kitchen', needsRegistration: false }),
      expect.objectContaining({ name: 'Attic', needsRegistration: true }),
    ]);
    expect(probeDevice).toHaveBeenCalledTimes(2);
  });

  it('should run one search for callers that ask at the same time', async () => {
    await Promise.all([platform.discoverForSetup(), platform.discoverForSetup()]);
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('should leave a device alone when its adapter changed protocol', async () => {
    discover.mockResolvedValueOnce([found({ host: '192.168.1.80', protocol: 'dsiot' })]);
    await platform.updateAddresses();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('now speaks dsiot instead of classic'));
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('should log a search that fails and carry on', async () => {
    discover.mockRejectedValueOnce(new Error('bind EADDRINUSE 0.0.0.0:30000'));
    await platform.updateAddresses();
    expect(log.warn).toHaveBeenCalledWith('The search for Daikin adapters failed: bind EADDRINUSE 0.0.0.0:30000');
    discover.mockRejectedValueOnce(new Error('bind EADDRINUSE 0.0.0.0:30000'));
    await expect(platform.discoverForSetup()).rejects.toThrow('EADDRINUSE');
  });

  it('should search at once when a device stops answering', async () => {
    const unit = unitAt('192.168.1.77');
    unit.getState.mockRejectedValue(new DaikinError('timed out', 504));
    await platform.pollDevices();
    expect(discover).not.toHaveBeenCalled();
    await platform.pollDevices();
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(1));
    expect((await platform.getSetupState()).devices[0]).toMatchObject({ status: 'offline', error: 'timed out' });
    await platform.pollDevices();
    expect(discover).toHaveBeenCalledTimes(1);
    unit.getState.mockImplementation(async () => ({ ...unit.state }));
    await settle();
  });

  it('should check, register with and identify adapters for the setup page', async () => {
    const capabilities = createCapabilities({ swingModes: [] });
    const ready: ProbeResult = { status: 'ready', device: found({ name: 'Bedroom', host: '192.168.1.51' }), capabilities };
    vi.mocked(probeDevice).mockResolvedValueOnce(ready);
    expect(await platform.probe(ready.device, '1234')).toBe(ready);
    expect(probeDevice).toHaveBeenCalledWith(ready.device, { terminalUuid: platform.config.terminalUuid, localPassword: '1234' });

    const unnamed: ProbeResult = { status: 'registrationRequired', device: found({ name: undefined, host: '192.168.1.61' }) };
    vi.mocked(registerWithDevice).mockResolvedValueOnce(unnamed);
    expect(await platform.register(unnamed.device, 'KEY')).toBe(unnamed);
    expect(registerWithDevice).toHaveBeenCalledWith(unnamed.device, 'KEY', { terminalUuid: platform.config.terminalUuid, localPassword: undefined });

    vi.mocked(identifyHost).mockResolvedValueOnce(found());
    expect(await platform.identify('192.168.1.50')).toEqual(found());
    expect(identifyHost).toHaveBeenCalledWith('192.168.1.50', platform.config.terminalUuid);
  });

  it('should add a device with what its setup check read, without asking the unit again', async () => {
    await platform.saveDevice({ ...bedroom, requiresLocalPassword: true, localPassword: '1234' });
    await settle();
    expect(unitAt('192.168.1.51').getCapabilities).not.toHaveBeenCalled();
    // The check found no swing and the fan is hidden: one endpoint.
    expect(platform.getDevices()).toHaveLength(4);
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ name: 'Bedroom' }), expect.objectContaining({ localPassword: '1234' }));
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ devices: [expect.objectContaining({ name: 'Living Room' }), expect.objectContaining({ name: 'Bedroom', localPassword: '1234' })] }),
    );
    expect((await platform.getSetupState()).devices[1]).toMatchObject({ name: 'Bedroom', hasLocalPassword: true, status: 'online' });
  });

  it('should keep the stored child lock code of a device saved without one, and use it for a check', async () => {
    // The unit swings on neither axis, so a fixed swing mode is not stored.
    await platform.saveDevice({ ...bedroom, requiresLocalPassword: true, fanSpeedWhenHidden: 'silent', swingModeWhenHidden: 'both' });
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        devices: expect.arrayContaining([expect.objectContaining({ name: 'Bedroom', localPassword: '1234', fanSpeedWhenHidden: 'silent', swingModeWhenHidden: 'keep' })]),
      }),
    );
    // Only a hidden setting changed: the endpoints stay.
    expect(log.info).not.toHaveBeenCalledWith('"Bedroom" stopped');

    vi.mocked(probeDevice).mockResolvedValueOnce({ status: 'unreachable', device: found({ name: 'Bedroom' }) });
    await platform.probe(found({ name: 'Bedroom', host: '192.168.1.51' }));
    expect(probeDevice).toHaveBeenCalledWith(expect.anything(), { terminalUuid: platform.config.terminalUuid, localPassword: '1234' });
  });

  it('should reconnect a device whose address or credentials were changed', async () => {
    await platform.saveDevice({ ...bedroom, host: '192.168.1.52' });
    expect(unitAt('192.168.1.51').dispose).toHaveBeenCalled();
    expect(unitAt('192.168.1.52').getState).toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalledWith('"Bedroom" stopped');
    // A device that no longer requires a code loses the stored one.
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ devices: expect.arrayContaining([expect.not.objectContaining({ localPassword: expect.anything() })]) }));
    expect((await platform.getSetupState()).devices[1]).toMatchObject({ host: '192.168.1.52', hasLocalPassword: false });
  });

  it('should build a device again when the check before a save found that its unit accepts other settings', async () => {
    const device = found({ name: 'Bedroom', host: '192.168.1.52' });
    const stored = { ...bedroom, host: '192.168.1.52' };
    // The same controls and a model code: nothing to build again.
    vi.mocked(probeDevice).mockResolvedValueOnce({ status: 'ready', device, capabilities: createCapabilities({ swingModes: [], model: '0ABB' }) });
    await platform.probe(device);
    await platform.saveDevice(stored);
    expect(log.info).not.toHaveBeenCalledWith('"Bedroom" stopped');

    vi.mocked(probeDevice).mockResolvedValueOnce({ status: 'ready', device, capabilities: createCapabilities({ swingModes: [], modes: ['cool', 'heat'] }) });
    await platform.probe(device);
    await platform.saveDevice(stored);
    expect(log.info).toHaveBeenCalledWith('"Bedroom" stopped');
    expect(log.info).toHaveBeenCalledWith('"Bedroom" started at 192.168.1.52 with 1 Matter endpoint(s)');
    expect((await platform.getSetupState()).devices[1]).toMatchObject({ capabilities: expect.objectContaining({ modes: ['cool', 'heat'] }) });

    vi.mocked(probeDevice).mockResolvedValueOnce({ status: 'ready', device, capabilities: createCapabilities({ swingModes: [] }) });
    await platform.probe(device);
    await platform.saveDevice(stored);
    expect(platform.getDevices()).toHaveLength(4);
    await settle();
  });

  it('should build the endpoints of a device again when its exposure changes', async () => {
    await platform.saveDevice({ ...livingRoom, host: '192.168.1.77', fanControl: 'percent', swingControl: 'hidden' });
    expect(log.info).toHaveBeenCalledWith('"Living Room" stopped');
    expect(log.info).toHaveBeenCalledWith('"Living Room" started at 192.168.1.77 with 1 Matter endpoint(s)');
    expect(platform.getDevices()).toHaveLength(2);
    await settle();
  });

  it('should keep a device that cannot be started and start it when its unit answers', async () => {
    const unit = unitAt('192.168.1.90');
    unit.getCapabilities.mockRejectedValue(new DaikinError('timed out', 504));
    await platform.context?.set(`capabilities:${macOf('Study')}`, 'not capabilities');
    await platform.saveDevice(createDeviceConfig({ name: 'Study', host: '192.168.1.90' }));
    expect(log.warn).toHaveBeenCalledWith('"Study" could not be started at 192.168.1.90 and will be retried: timed out');
    expect((await platform.getSetupState()).devices[2]).toMatchObject({ name: 'Study', status: 'stopped', error: 'timed out', capabilities: undefined, controls: undefined });
    expect(platform.getDevices()).toHaveLength(2);

    // The same failure is not logged again on each retry.
    vi.mocked(log.warn).mockClear();
    await platform.updateAddresses();
    expect(log.warn).not.toHaveBeenCalled();

    unit.getCapabilities.mockResolvedValue(createCapabilities({ modes: ['fan'] }));
    await platform.updateAddresses();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('neither cools nor heats'));
    await platform.context?.remove(`capabilities:${macOf('Study')}`);

    unit.getCapabilities.mockResolvedValue(createCapabilities());
    unit.dispose.mockRejectedValueOnce(new Error('close failed'));
    await platform.saveDevice(createDeviceConfig({ name: 'Study', host: '192.168.1.90', fanControl: 'hidden' }));
    // Living Room, Bedroom, and Study with its two swing switches.
    expect(platform.getDevices()).toHaveLength(5);
    expect((await platform.getSetupState()).devices[2]).toMatchObject({ capabilities: expect.objectContaining({ modes: expect.arrayContaining(['cool']) }) });
    await settle();
  });

  it('should take back the endpoints of a device whose registration fails halfway', async () => {
    const registerDevice = vi.spyOn(platform, 'registerDevice');
    registerDevice.mockImplementationOnce(async (endpoint) => DaikinPlatform.prototype.registerDevice.call(platform, endpoint)).mockRejectedValueOnce('aggregator is full');
    await platform.saveDevice(createDeviceConfig({ name: 'Attic', host: '192.168.1.91' }));
    expect(log.warn).toHaveBeenCalledWith('"Attic" could not be started at 192.168.1.91 and will be retried: aggregator is full');
    expect(platform.getDevices()).toHaveLength(5);
    registerDevice.mockRestore();
    expect(await platform.removeDevice(macOf('Attic'))).toBe(true);
  });

  it('should remove a device, its endpoints and what was known about its unit', async () => {
    expect(await platform.removeDevice(macOf('Nobody'))).toBe(false);
    expect(await platform.removeDevice(macOf('Study'))).toBe(true);
    expect(log.info).toHaveBeenCalledWith('"Study" stopped');
    expect(platform.getDevices()).toHaveLength(2);
    expect(await platform.context?.get(`capabilities:${macOf('Study')}`)).toBeUndefined();
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ devices: [expect.objectContaining({ name: 'Living Room' }), expect.objectContaining({ name: 'Bedroom' })] }));
  });

  /**
   * Save the stored configuration with changes, as the config editor does from a page that shows the stored configuration
   *
   * @param {Partial<DaikinPlatformConfig>} changes The fields the user changed.
   * @returns {Promise<void>} Resolves when the platform has applied the configuration.
   */
  async function saveInEditor(changes: Partial<DaikinPlatformConfig>): Promise<void> {
    // The page was loaded long after the plugin last stored its configuration, so the save is not taken for that one
    // coming back. Each save is later than the one before.
    editorClock += 60_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(editorClock);
    try {
      // As Matterbridge does: the saved configuration becomes the configuration of the platform, which is then told.
      platform.config = { ...structuredClone(platform.config), ...changes };
      await platform.onConfigChanged(platform.config);
    } finally {
      clock.mockRestore();
    }
  }

  it('should not use what an older version stored about a unit, before special modes were read', async () => {
    await platform.context?.set('capabilities:A4:08:EA:CC:00:70', { ...createCapabilities(), specialModes: undefined });
    await platform.saveDevice(createDeviceConfig({ name: 'Pantry', host: '192.168.1.70', macAddress: 'A4:08:EA:CC:00:70', swingControl: 'hidden' }));
    expect(unitAt('192.168.1.70').getCapabilities).toHaveBeenCalledTimes(1);
    expect((await platform.getSetupState()).devices[2]).toMatchObject({ name: 'Pantry', macAddress: 'A4:08:EA:CC:00:70' });
    expect(platform.getDevices()).toHaveLength(3);
  });

  it('should follow a device by its MAC address to a new address, and keep its name whatever its adapter is named', async () => {
    discover.mockResolvedValueOnce([found({ name: 'Larder', host: '192.168.1.71', macAddress: 'a408eacc0070' })]);
    expect(await platform.discoverForSetup()).toEqual([expect.objectContaining({ name: 'Larder', isConfigured: true })]);
    expect(log.notice).toHaveBeenCalledWith('"Pantry" moved from 192.168.1.70 to 192.168.1.71');
    // A new address connects the device anew, without building it again in Matter.
    expect(log.info).not.toHaveBeenCalledWith('"Pantry" stopped');
    // What is known about the unit is kept under its MAC address, so the unit is not asked again.
    expect(unitAt('192.168.1.71').getCapabilities).not.toHaveBeenCalled();
    expect((await platform.getSetupState()).devices[2]).toMatchObject({ name: 'Pantry', host: '192.168.1.71', capabilities: expect.anything() });
  });

  it('should build a device again under the name it is given in the setup page', async () => {
    await platform.saveDevice(createDeviceConfig({ name: 'Larder', host: '192.168.1.71', swingControl: 'hidden', macAddress: 'A4:08:EA:CC:00:70' }));
    expect(log.info).toHaveBeenCalledWith('"Pantry" stopped');
    expect(log.info).toHaveBeenCalledWith('"Larder" started at 192.168.1.71 with 1 Matter endpoint(s)');
    // The serial number is the MAC address, which a new name does not change.
    expect(platform.getDeviceBySerialNumber('A4:08:EA:CC:00:70')?.deviceName).toBe('Larder');
  });

  it('should keep the name of a device whose adapter takes the name of another device, or none', async () => {
    discover.mockResolvedValueOnce([found({ name: 'Bedroom', host: '192.168.1.71', macAddress: 'A4:08:EA:CC:00:70' })]);
    await platform.updateAddresses();
    discover.mockResolvedValueOnce([found({ name: undefined, host: '192.168.1.71', macAddress: 'A4:08:EA:CC:00:70' })]);
    await platform.updateAddresses();
    expect(saveConfig).not.toHaveBeenCalled();
    expect((await platform.getSetupState()).devices.map((device) => `${device.name}@${device.host}`)).toEqual([
      'Living Room@192.168.1.77',
      'Bedroom@192.168.1.52',
      'Larder@192.168.1.71',
    ]);
    // An adapter that changed its requirements where it is takes them, without a notice of a new address.
    discover.mockResolvedValueOnce([found({ name: 'Larder', host: '192.168.1.71', macAddress: 'A4:08:EA:CC:00:70', usesHttps: true })]);
    await platform.updateAddresses();
    expect((await platform.getSetupState()).devices[2]).toMatchObject({ name: 'Larder', usesHttps: true });
    expect(log.notice).not.toHaveBeenCalledWith(expect.stringContaining('moved from'));
    discover.mockResolvedValueOnce([found({ name: 'Larder', host: '192.168.1.71', macAddress: 'A4:08:EA:CC:00:70' })]);
    await platform.updateAddresses();
  });

  it('should refuse a name another device has, and rename a device saved under its MAC address', async () => {
    const other = createDeviceConfig({ name: 'Larder', host: '192.168.1.74' });
    await expect(platform.saveDevice(other)).rejects.toThrow('Another air conditioner is already named "Larder"');
    expect(await platform.onFetch('POST', 'device', {}, { device: other })).toEqual({ ok: false, error: 'Another air conditioner is already named "Larder"' });

    await platform.saveDevice(createDeviceConfig({ name: 'Lobby', host: '192.168.1.71', swingControl: 'hidden', macAddress: 'A4:08:EA:CC:00:70' }));
    expect(log.info).toHaveBeenCalledWith('"Larder" stopped');
    expect(log.info).toHaveBeenCalledWith('"Lobby" started at 192.168.1.71 with 1 Matter endpoint(s)');
    expect(await platform.removeDevice('A4:08:EA:CC:00:70')).toBe(true);
    expect(platform.getDevices()).toHaveLength(2);
  });

  it('should apply the poll interval saved in the config editor, and leave the devices to the setup page', async () => {
    // The editor does not list the devices, but sends back the ones its page loaded.
    await saveInEditor({ pollIntervalInSeconds: 60, devices: [] });
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    // Every device is connected again, with commands built from a poll of at most 30 seconds ago.
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ name: 'Bedroom' }), expect.objectContaining({ maxStateAgeForSetStateInMs: 30_000 }));
    expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('stopped'));
    expect(platform.getDevices()).toHaveLength(2);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('should apply the state age for a command saved in the config editor, without starting the timers again', async () => {
    await saveInEditor({ maxStateAgeForCommandInSeconds: 10 });
    // Every device is connected again, with commands built from a poll of at most 10 seconds ago.
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ name: 'Bedroom' }), expect.objectContaining({ maxStateAgeForSetStateInMs: 10_000 }));
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(platform.getDevices()).toHaveLength(2);

    // At 0 every command reads the unit first.
    await saveInEditor({ maxStateAgeForCommandInSeconds: 0 });
    expect(createClient).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ maxStateAgeForSetStateInMs: 0 }));

    await saveInEditor({ maxStateAgeForCommandInSeconds: 30 });
    expect(createClient).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ maxStateAgeForSetStateInMs: 30_000 }));
  });

  it('should keep its devices when the config editor saves a page that was loaded before they changed', async () => {
    const terminalUuid = platform.getTerminalUuid();
    const loaded = structuredClone(platform.config);
    await platform.saveDevice(createDeviceConfig({ name: 'Kitchen', host: '192.168.1.60' }));
    await settle();
    vi.clearAllMocks();

    // The page still holds the two devices it loaded. Someone changes the poll interval there and saves.
    editorClock += 60_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(editorClock);
    platform.config = { ...loaded, pollIntervalInSeconds: 45 };
    await platform.onConfigChanged(platform.config);
    clock.mockRestore();
    // Kitchen is still there, in Matter and in the configuration, which is stored again with it.
    expect(log.info).not.toHaveBeenCalledWith('"Kitchen" stopped');
    expect(platform.getDevices()).toHaveLength(5);
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ pollIntervalInSeconds: 45, terminalUuid, devices: expect.arrayContaining([expect.objectContaining({ name: 'Kitchen' })]) }),
    );
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 45_000);

    await saveInEditor({ pollIntervalInSeconds: 60 });
    expect(await platform.removeDevice(macOf('Kitchen'))).toBe(true);
    expect(platform.getDevices()).toHaveLength(2);
  });

  it('should not apply again a device list it stored itself', async () => {
    await platform.saveDevice(createDeviceConfig({ name: 'Kitchen', host: '192.168.1.60' }));
    const [stored] = saveConfig.mock.lastCall ?? [];
    if (stored === undefined) throw new Error('The device list was not stored');
    const echoed: PlatformConfig = structuredClone(stored);
    vi.clearAllMocks();
    await platform.onConfigChanged(echoed);
    expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('started'));
    expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('stopped'));
    expect(platform.getDevices()).toHaveLength(5);
    expect(await platform.removeDevice(macOf('Kitchen'))).toBe(true);
  });

  it('should take the terminal uuid saved in the config editor, and keep its own when that one is missing or wrong', async () => {
    const terminalUuid = platform.getTerminalUuid();
    await saveInEditor({ terminalUuid: '' });
    expect(saveConfig).toHaveBeenLastCalledWith(expect.objectContaining({ terminalUuid }));
    await saveInEditor({ terminalUuid: 'not a uuid' });
    expect(saveConfig).toHaveBeenLastCalledWith(expect.objectContaining({ terminalUuid }));
    expect(platform.getTerminalUuid()).toBe(terminalUuid);
    expect(createClient).not.toHaveBeenCalled();

    // The same one in upper case connects nothing again, and is stored in the form the adapters are sent.
    await saveInEditor({ terminalUuid: terminalUuid.toUpperCase() });
    expect(createClient).not.toHaveBeenCalled();
    expect(saveConfig).toHaveBeenLastCalledWith(expect.objectContaining({ terminalUuid }));

    // One with dashes is taken without them.
    await saveInEditor({ terminalUuid: '99999999-2222-3333-4444-555555555555' });
    expect(platform.getTerminalUuid()).toBe('99999999222233334444555555555555');
    expect(log.notice).toHaveBeenCalledWith('The terminal uuid is now 99999999222233334444555555555555');
    expect(saveConfig).toHaveBeenLastCalledWith(expect.objectContaining({ terminalUuid: '99999999222233334444555555555555' }));
    // Every device is connected again with it.
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ terminalUuid: '99999999222233334444555555555555' }));
  });

  it('should log a change to the devices that fails', async () => {
    createClient.mockImplementationOnce(() => {
      throw new Error('bad host');
    });
    await expect(platform.saveDevice(createDeviceConfig({ name: 'Garage', host: '192.168.1.95' }))).rejects.toThrow('bad host');
    expect(log.error).toHaveBeenCalledWith('A change to the devices failed: bad host');
    createClient.mockImplementationOnce(() => {
      throw new Error('bad host');
    });
    await platform.updateAddresses();
    expect(log.error).toHaveBeenCalledWith('A change to the devices failed: bad host');
    expect(await platform.removeDevice(macOf('Garage'))).toBe(true);
  });

  it('should give each reading of a unit its place in Matter, from the first time the unit gives it', async () => {
    const count = platform.getDevices().length;
    const attic = createDeviceConfig({ name: 'Attic', host: '192.168.1.97', fanControl: 'hidden', swingControl: 'hidden' });
    const unit = unitAt('192.168.1.97');
    unit.sensors = { indoorTemperatureInC: 26, outdoorTemperatureInC: null, indoorHumidityInPercent: 55 };
    const adapter = found({ name: 'Attic', host: '192.168.1.97' });
    const find = (name: string): MatterbridgeEndpoint | undefined => platform.getDevices().find((device) => device.deviceName === name);

    // The setup check read a humidity: the air conditioner shows it from the start.
    vi.mocked(probeDevice).mockResolvedValueOnce({ status: 'ready', device: adapter, capabilities: createCapabilities(), sensors: { ...unit.sensors } });
    await platform.probe(adapter);
    await platform.saveDevice(attic);
    await settle();
    expect(platform.getDevices()).toHaveLength(count + 1);
    expect(find('Attic')?.getAttribute(RelativeHumidityMeasurement, 'measuredValue')).toBe(5500);
    expect(log.notice).not.toHaveBeenCalledWith(expect.stringContaining('built again'));

    // Later the unit gives its outdoor temperature too: the device is built again, with a sensor for it.
    unit.sensors.outdoorTemperatureInC = 31;
    await platform.pollDevices();
    expect(log.notice).toHaveBeenCalledWith('"Attic" gave a reading it shows nowhere in Matter yet: it is built again in Matter');
    expect(platform.getDevices()).toHaveLength(count + 2);
    await platform.pollDevices();
    expect(find('Attic Outdoor Temperature')?.getAttribute(TemperatureMeasurement, 'measuredValue')).toBe(3100);
    expect(find('Attic')?.getAttribute(RelativeHumidityMeasurement, 'measuredValue')).toBe(5500);

    // A check that reads neither takes nothing away from what the unit is known to give.
    vi.mocked(probeDevice).mockResolvedValueOnce({
      status: 'ready',
      device: adapter,
      capabilities: createCapabilities(),
      sensors: { ...unit.sensors, outdoorTemperatureInC: null },
    });
    await platform.probe(adapter);
    await platform.saveDevice(attic);
    expect(await platform.context?.get(`sensors:${macOf('Attic')}`)).toEqual({ hasHumidity: true, hasOutdoorTemperature: true });
    expect(platform.getDevices()).toHaveLength(count + 2);

    // A device that cannot be built again is started by the next search, with what was stored about its unit.
    const shed = createDeviceConfig({ name: 'Shed', host: '192.168.1.98', fanControl: 'hidden', swingControl: 'hidden' });
    await platform.saveDevice(shed);
    await settle();
    expect(platform.getDevices()).toHaveLength(count + 3);
    unitAt('192.168.1.98').sensors.outdoorTemperatureInC = 12;
    createClient.mockImplementationOnce(() => {
      throw new Error('bad host');
    });
    await platform.pollDevices();
    expect(log.error).toHaveBeenCalledWith('A change to the devices failed: bad host');
    await settle();
    expect(find('Shed Outdoor Temperature')?.getAttribute(TemperatureMeasurement, 'measuredValue')).toBe(1200);

    expect(await platform.removeDevice(macOf('Attic'))).toBe(true);
    expect(await platform.removeDevice(macOf('Shed'))).toBe(true);
    expect(await platform.context?.get(`sensors:${macOf('Attic')}`)).toBeUndefined();
    expect(platform.getDevices()).toHaveLength(count);
  });

  it('should change logger level', async () => {
    await platform.onChangeLoggerLevel(LogLevel.DEBUG);
    expect(log.info).toHaveBeenCalledWith('onChangeLoggerLevel called with: debug');
  });

  it('should stop its timers and dispose of every device on shutdown', async () => {
    await platform.onShutdown('Vitest');
    expect(log.info).toHaveBeenCalledWith(`Shutting down platform ${pluginName} with reason: Vitest...`);
    expect(unitAt('192.168.1.77').dispose).toHaveBeenCalled();
    expect(unitAt('192.168.1.52').dispose).toHaveBeenCalled();
    expect((await platform.getSetupState()).devices.map((device) => device.status)).toEqual(['stopped', 'stopped']);
    await platform.pollDevices();
    expect(unitAt('192.168.1.77').getState).not.toHaveBeenCalled();
  });

  it('should check after a start what each unit accepts, and build a device again when that changed', async () => {
    await platform.unregisterAllDevices();
    const terminalUuid = platform.getTerminalUuid();
    const devices = [
      { ...livingRoom, host: '192.168.1.77', modeControl: 'switches', modeSwitches: ['fan'] },
      { ...bedroom, host: '192.168.1.52' },
    ];
    const living = unitAt('192.168.1.77');
    const bed = unitAt('192.168.1.52');
    // The living room unit lost its fan mode and its horizontal swing. The bedroom unit only reports a model code now.
    living.getCapabilities.mockResolvedValue(createCapabilities({ modes: ['cool', 'heat'], swingModes: ['off', 'vertical'] }));
    bed.getCapabilities.mockRejectedValueOnce(new DaikinError('timed out', 504)).mockResolvedValue(createCapabilities({ swingModes: [], model: '0ABB' }));
    living.getState.mockRejectedValueOnce(new DaikinError('timed out', 504));

    const again = new DaikinPlatform(matterbridge, log, createConfig({ terminalUuid, devices, setupRevision: 7 }));
    addMatterbridge(again);
    await again.onStart();
    // Started from what was stored: the air conditioner, two swing switches and the fan mode switch, and the bedroom.
    expect(again.getDevices()).toHaveLength(5);
    expect(living.getCapabilities).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(living.getState).toHaveBeenCalled());

    // A unit is asked once it answers, and asked again later when the question fails.
    await again.updateAddresses();
    expect(living.getCapabilities).not.toHaveBeenCalled();
    await again.pollDevices();
    await again.updateAddresses();
    expect(living.getCapabilities).toHaveBeenCalledTimes(1);
    // The bedroom unit answered from the start, so it was asked twice: the first question failed.
    expect(bed.getCapabilities).toHaveBeenCalledTimes(2);
    expect(log.notice).toHaveBeenCalledWith('"Living Room" accepts other settings than when it was set up: it is built again in Matter');
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ devices: [expect.objectContaining({ name: 'Living Room', modeControl: 'native', modeSwitches: [] }), expect.anything()] }),
    );
    // The air conditioner and its one swing switch, and the bedroom.
    expect(again.getDevices()).toHaveLength(3);

    vi.mocked(log.notice).mockClear();
    await again.pollDevices();
    await again.updateAddresses();
    await again.updateAddresses();
    expect(living.getCapabilities).toHaveBeenCalledTimes(1);
    expect(bed.getCapabilities).toHaveBeenCalledTimes(2);
    expect(log.notice).not.toHaveBeenCalledWith(expect.stringContaining('built again'));
    expect((await again.getSetupState()).devices[1]).toMatchObject({ name: 'Bedroom', capabilities: expect.objectContaining({ model: '0ABB' }) });
    expect(again.getDevices()).toHaveLength(3);

    await again.onShutdown();
    await again.unregisterAllDevices();
  });

  it('should store again a device it cannot read until a device takes its place', async () => {
    const terminalUuid = platform.getTerminalUuid();
    // A device as a later version might store it, and one without the MAC address of its adapter.
    const fromLater = { ...createDeviceConfig({ name: 'Annex', host: '192.168.1.97' }), protocol: 'later' };
    const incomplete = { name: 'Cellar', host: '192.168.1.98' };
    const keeper = new DaikinPlatform(matterbridge, log, createConfig({ terminalUuid, devices: [fromLater, incomplete] }));
    addMatterbridge(keeper);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('It stays in the configuration as it is'));
    await keeper.onStart();
    expect(keeper.getDevices()).toHaveLength(0);

    // The adapter of the first is added again under another name: the other one stays.
    await keeper.saveDevice(createDeviceConfig({ name: 'Loft', host: '192.168.1.97', macAddress: fromLater.macAddress }));
    expect(saveConfig).toHaveBeenLastCalledWith(expect.objectContaining({ devices: [expect.objectContaining({ name: 'Loft' }), incomplete] }));
    await keeper.saveDevice(createDeviceConfig({ name: 'Cellar', host: '192.168.1.98' }));
    expect(saveConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ devices: [expect.objectContaining({ name: 'Loft' }), expect.objectContaining({ name: 'Cellar', protocol: 'classic' })] }),
    );

    expect(await keeper.removeDevice(fromLater.macAddress)).toBe(true);
    expect(await keeper.removeDevice(macOf('Cellar'))).toBe(true);
    await keeper.onShutdown();
    await keeper.unregisterAllDevices();
  });

  it('should store a terminal uuid again without its dashes when it was stored with them', async () => {
    const migrated = new DaikinPlatform(matterbridge, log, createConfig({ terminalUuid: '0D120767-302B-4603-B5AE-916260815E4E', devices: [] }));
    addMatterbridge(migrated);
    await migrated.onStart();
    expect(migrated.getTerminalUuid()).toBe('0d120767302b4603b5ae916260815e4e');
    expect(log.notice).not.toHaveBeenCalled();
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ terminalUuid: '0d120767302b4603b5ae916260815e4e' }));
    await vi.waitFor(() => expect(discover).toHaveBeenCalled());
    await migrated.onShutdown();
  });

  it('should start again with the stored terminal uuid and unregister on shutdown when asked to', async () => {
    const terminalUuid = platform.getTerminalUuid();
    const restarted = new DaikinPlatform(matterbridge, log, createConfig({ terminalUuid, devices: [], unregisterOnShutdown: true }));
    addMatterbridge(restarted);
    await restarted.onStart();
    expect(log.info).toHaveBeenCalledWith(`Starting platform ${pluginName} with reason: no reason provided...`);
    expect(restarted.getTerminalUuid()).toBe(terminalUuid);
    // A configuration from before the plugin counted its own changes is taken as it is.
    await restarted.onConfigChanged(createConfig({ terminalUuid, devices: [], unregisterOnShutdown: true }));
    expect(log.warn).not.toHaveBeenCalled();
    expect(saveConfig).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(discover).toHaveBeenCalled());

    // Without its storage the platform asks the unit what it accepts, and remembers nothing.
    restarted.context = undefined;
    await restarted.saveDevice(createDeviceConfig({ name: 'Porch', host: '192.168.1.96', swingControl: 'hidden' }));
    expect(unitAt('192.168.1.96').getCapabilities).toHaveBeenCalledTimes(1);
    expect((await restarted.getSetupState()).devices[0]).toMatchObject({ name: 'Porch', capabilities: undefined });
    expect(await restarted.removeDevice(macOf('Porch'))).toBe(true);
    await restarted.onShutdown();
    expect(log.info).toHaveBeenCalledWith(`Shutting down platform ${pluginName} with reason: no reason provided...`);
  });
});
