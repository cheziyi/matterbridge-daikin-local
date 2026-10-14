/**
 * @file vitest/accessory/daikinAccessory.test.ts
 * @description This file contains the tests for the bridge between a Daikin unit and its Matter endpoints.
 * @author Calvin Che
 */

/**
 * WARNING!!!
 * The tests in this unit are supposed to run sequentially because they depend on the Matter state.
 */

import { DaikinError, type DaikinSensors } from 'daikin-local-control';
import type { MatterbridgeEndpoint } from 'matterbridge';
import { type ActionContext, CommonNumberTag } from 'matterbridge/matter';
import {
  BridgedDeviceBasicInformation,
  Descriptor,
  FanControl,
  ModeSelect,
  OnOff,
  RelativeHumidityMeasurement,
  TemperatureMeasurement,
  Thermostat,
} from 'matterbridge/matter/clusters';
import { log, setupTest } from 'matterbridge/vitest-utils';
import { addDevice, aggregator, createServerNode, createTestEnvironment, startServerNode, stopServerNode } from 'matterbridge/vitest-utils/matter';

import { DaikinAccessory } from '../../src/accessory/daikinAccessory.js';
import { readFanSpeed } from '../../src/accessory/matterState.js';
import { PendingCommand } from '../../src/accessory/pendingCommand.js';
import { createCapabilities, createDeviceConfig, createFakeClient, type FakeClient, macOf } from '../fakeDaikin.js';

const online = { fabric: 1 } as unknown as ActionContext;
const offline = { offline: true } as unknown as ActionContext;
const vendorId = 0xfff1;

/**
 * Add every endpoint of an accessory to the test aggregator
 *
 * @param {DaikinAccessory} accessory The accessory.
 * @returns {Promise<void>} Resolves when the endpoints are active.
 */
async function addAccessory(accessory: DaikinAccessory): Promise<void> {
  for (const endpoint of accessory.endpoints) expect(await addDevice(aggregator, endpoint)).toBe(true);
}

/**
 * Write several attributes the way a controller does in one go: every value lands, then the changes are announced with a
 * fabric, one right after the other
 *
 * Nothing is awaited between the announcements, so however slow the machine is, the command delay cannot run out
 * between two of them.
 *
 * @param {MatterbridgeEndpoint} endpoint The endpoint.
 * @param {readonly (readonly [string, string, unknown])[]} writes The cluster name, the attribute name and the value of each write.
 * @returns {Promise<void>} Resolves when the changes are announced.
 */
async function writeTogetherAsController(endpoint: MatterbridgeEndpoint, writes: readonly (readonly [cluster: string, attribute: string, value: unknown])[]): Promise<void> {
  const announcements: (() => void)[] = [];
  for (const [cluster, attribute, value] of writes) {
    const previous: unknown = endpoint.getAttribute(cluster, attribute);
    await endpoint.setAttribute(cluster, attribute, value as never);
    const events = endpoint.eventsOf(cluster.charAt(0).toLowerCase() + cluster.slice(1)) as Record<string, { emit: (...parameters: unknown[]) => void } | undefined>;
    announcements.push(() => events[`${attribute}$Changed`]?.emit(value, previous, online));
  }
  for (const announce of announcements) announce();
}

/**
 * Write an attribute the way a controller does: the value lands, then the change is announced with a fabric
 *
 * @param {MatterbridgeEndpoint} endpoint The endpoint.
 * @param {string} cluster The cluster name.
 * @param {string} attribute The attribute name.
 * @param {unknown} value The value to write.
 * @returns {Promise<void>} Resolves when the change is announced.
 */
async function writeAsController(endpoint: MatterbridgeEndpoint, cluster: string, attribute: string, value: unknown): Promise<void> {
  await writeTogetherAsController(endpoint, [[cluster, attribute, value]]);
}

await setupTest('DaikinAccessory', false);

describe('DaikinAccessory', () => {
  beforeAll(async () => {
    await createTestEnvironment();
    await createServerNode(6101);
    await startServerNode();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await stopServerNode();
    vi.restoreAllMocks();
  });

  describe('a unit that heats and cools, with fan steps and swing switches', () => {
    let client: FakeClient;
    let accessory: DaikinAccessory;

    it('should create the air conditioner and one switch for each swing axis', async () => {
      client = createFakeClient();
      // Longer than a slow machine takes between two writes of a test, so that a command only goes out when a test sends it.
      accessory = new DaikinAccessory({ config: createDeviceConfig(), capabilities: createCapabilities(), client, log, vendorId, commandDelayInMs: 500 });
      expect(accessory.endpoints).toHaveLength(3);
      expect(accessory.endpoint.deviceName).toBe('Living Room');
      expect(accessory.verticalSwitch?.deviceName).toBe('Living Room Vertical Swing');
      expect(accessory.horizontalSwitch?.deviceName).toBe('Living Room Horizontal Swing');
      // The serial number is the MAC address of the adapter, with one letter more on each endpoint beside the air conditioner.
      expect(accessory.endpoint.serialNumber).toBe(macOf('Living Room'));
      expect(accessory.verticalSwitch?.serialNumber).toMatch(new RegExp(`^${macOf('Living Room')}[A-Z]$`));
      expect(accessory.getStatus()).toEqual({ isReachable: false, lastError: undefined, state: undefined });
      await addAccessory(accessory);
      expect(accessory.endpoint.getAttribute(FanControl, 'speedMax')).toBe(6);
      expect(accessory.endpoint.getAttribute(FanControl, 'fanModeSequence')).toBe(FanControl.FanModeSequence.OffLowMedHighAuto);
      expect(accessory.endpoint.getAttribute(Thermostat, 'minHeatSetpointLimit')).toBe(1000);
      expect(accessory.endpoint.getAttribute(Thermostat, 'maxCoolSetpointLimit')).toBe(3200);
    });

    it('should write the state of the unit to Matter when it is read', async () => {
      expect(await accessory.refresh()).toBe(true);
      const { endpoint } = accessory;
      expect(endpoint.getAttribute(BridgedDeviceBasicInformation, 'reachable')).toBe(true);
      expect(endpoint.getAttribute(OnOff, 'onOff')).toBe(true);
      expect(endpoint.getAttribute(Thermostat, 'systemMode')).toBe(Thermostat.SystemMode.Cool);
      expect(endpoint.getAttribute(Thermostat, 'occupiedCoolingSetpoint')).toBe(2400);
      expect(endpoint.getAttribute(Thermostat, 'localTemperature')).toBe(2650);
      expect(endpoint.getAttribute(Thermostat, 'thermostatRunningState')).toMatchObject({ cool: true, heat: false, fan: true });
      // level3 is the fourth of silent, level1 to level5.
      expect(endpoint.getAttribute(FanControl, 'percentSetting')).toBe(66);
      expect(endpoint.getAttribute(FanControl, 'percentCurrent')).toBe(66);
      expect(endpoint.getAttribute(FanControl, 'speedSetting')).toBe(4);
      expect(endpoint.getAttribute(FanControl, 'speedCurrent')).toBe(4);
      expect(endpoint.getAttribute(FanControl, 'fanMode')).toBe(FanControl.FanMode.Medium);
      expect(accessory.verticalSwitch?.getAttribute(OnOff, 'onOff')).toBe(true);
      expect(accessory.horizontalSwitch?.getAttribute(OnOff, 'onOff')).toBe(false);
      expect(accessory.getStatus()).toMatchObject({ isReachable: true, state: { mode: 'cool' } });
      expect(client.setState).not.toHaveBeenCalled();
    });

    it('should report a unit that is off as off, and auto as a fan mode', async () => {
      Object.assign(client.state, { power: false, fanSpeed: 'auto', swingMode: 'off' });
      await accessory.refresh();
      expect(accessory.endpoint.getAttribute(OnOff, 'onOff')).toBe(false);
      expect(accessory.endpoint.getAttribute(Thermostat, 'systemMode')).toBe(Thermostat.SystemMode.Off);
      expect(accessory.endpoint.getAttribute(Thermostat, 'thermostatRunningState')).toMatchObject({ cool: false, fan: false });
      expect(accessory.endpoint.getAttribute(FanControl, 'fanMode')).toBe(FanControl.FanMode.Auto);
      expect(accessory.endpoint.getAttribute(FanControl, 'percentSetting')).toBeNull();
      expect(accessory.verticalSwitch?.getAttribute(OnOff, 'onOff')).toBe(false);
    });

    it('should ask the unit what it accepts now', async () => {
      expect(accessory.capabilities).toEqual(createCapabilities());
      const now = createCapabilities({ modes: ['cool'] });
      client.getCapabilities.mockResolvedValueOnce(now);
      expect(await accessory.readCapabilities()).toBe(now);
      client.getCapabilities.mockRejectedValueOnce(new DaikinError('timed out', 504));
      await expect(accessory.readCapabilities()).rejects.toThrow('timed out');
      expect(await accessory.refresh()).toBe(true);
    });

    it('should ignore the changes it makes itself', async () => {
      accessory.endpoint.eventsOf('onOff').onOff$Changed?.emit(true, false, offline);
      await accessory.flushCommands();
      expect(client.setState).not.toHaveBeenCalled();
    });

    it('should turn the unit on and off when a controller does', async () => {
      await writeAsController(accessory.endpoint, 'OnOff', 'onOff', true);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenCalledWith({ power: true });
      // The state is read back after a command. The sensors of the last poll go with it.
      expect(client.getState).toHaveBeenCalledTimes(1);
      expect(client.getSensors).not.toHaveBeenCalled();
      expect(accessory.endpoint.getAttribute(Thermostat, 'systemMode')).toBe(Thermostat.SystemMode.Cool);

      await writeAsController(accessory.endpoint, 'Thermostat', 'systemMode', Thermostat.SystemMode.Off);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ power: false });
      expect(accessory.endpoint.getAttribute(OnOff, 'onOff')).toBe(false);
    });

    it('should send a mode and its setpoint as one command', async () => {
      await writeAsController(accessory.endpoint, 'Thermostat', 'occupiedHeatingSetpoint', 2230);
      await writeAsController(accessory.endpoint, 'Thermostat', 'systemMode', Thermostat.SystemMode.Heat);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenCalledTimes(1);
      // 22.3 °C is rounded to the unit's half degree step.
      expect(client.setState).toHaveBeenCalledWith({ power: true, mode: 'heat', targetTemperatureInC: 22.5 });
      expect(accessory.endpoint.getAttribute(Thermostat, 'systemMode')).toBe(Thermostat.SystemMode.Heat);
      expect(accessory.endpoint.getAttribute(Thermostat, 'occupiedHeatingSetpoint')).toBe(2250);
      expect(accessory.endpoint.getAttribute(Thermostat, 'thermostatRunningState')).toMatchObject({ heat: true, cool: false });
    });

    it('should drop a setpoint of a mode the unit is not in', async () => {
      await writeAsController(accessory.endpoint, 'Thermostat', 'occupiedCoolingSetpoint', 2600);
      await accessory.flushCommands();
      expect(client.setState).not.toHaveBeenCalled();
    });

    it('should use the setpoint that moved when the unit is in auto', async () => {
      await writeAsController(accessory.endpoint, 'Thermostat', 'systemMode', Thermostat.SystemMode.Auto);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ power: true, mode: 'auto' });
      // The unit holds one setpoint, which both Matter setpoints show.
      expect(accessory.endpoint.getAttribute(Thermostat, 'occupiedCoolingSetpoint')).toBe(2250);
      expect(accessory.endpoint.getAttribute(Thermostat, 'occupiedHeatingSetpoint')).toBe(2250);

      await writeAsController(accessory.endpoint, 'Thermostat', 'occupiedCoolingSetpoint', 2400);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ targetTemperatureInC: 24 });
      expect(accessory.endpoint.getAttribute(Thermostat, 'occupiedHeatingSetpoint')).toBe(2400);
      // Indoors is 26.5 °C, above the setpoint.
      expect(accessory.endpoint.getAttribute(Thermostat, 'thermostatRunningState')).toMatchObject({ cool: true, heat: false });

      client.sensors.indoorTemperatureInC = 20;
      await accessory.refresh();
      expect(accessory.endpoint.getAttribute(Thermostat, 'thermostatRunningState')).toMatchObject({ cool: false, heat: true });
      client.sensors.indoorTemperatureInC = null;
      await accessory.refresh();
      expect(accessory.endpoint.getAttribute(Thermostat, 'thermostatRunningState')).toMatchObject({ cool: false, heat: false });
      // A room temperature the unit does not give is no value in Matter, not the last one it gave.
      expect(accessory.endpoint.getAttribute(Thermostat, 'localTemperature')).toBeNull();
      client.sensors.indoorTemperatureInC = 26.5;
      await accessory.refresh();
      expect(accessory.endpoint.getAttribute(Thermostat, 'localTemperature')).toBe(2650);
    });

    it('should map the dry and fan modes and leave their setpoint alone', async () => {
      await writeAsController(accessory.endpoint, 'Thermostat', 'systemMode', Thermostat.SystemMode.Dry);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ power: true, mode: 'dehumidify' });
      client.state.targetTemperatureInC = null;
      await accessory.refresh();
      expect(accessory.endpoint.getAttribute(Thermostat, 'systemMode')).toBe(Thermostat.SystemMode.Dry);
      expect(accessory.endpoint.getAttribute(Thermostat, 'occupiedCoolingSetpoint')).toBe(2400);

      await writeAsController(accessory.endpoint, 'Thermostat', 'systemMode', Thermostat.SystemMode.FanOnly);
      await writeAsController(accessory.endpoint, 'Thermostat', 'occupiedCoolingSetpoint', 2500);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ power: true, mode: 'fan' });
      expect(accessory.endpoint.getAttribute(Thermostat, 'systemMode')).toBe(Thermostat.SystemMode.FanOnly);
    });

    it('should ignore a system mode the unit has no mode for', async () => {
      await writeAsController(accessory.endpoint, 'Thermostat', 'systemMode', Thermostat.SystemMode.Sleep);
      await accessory.flushCommands();
      expect(client.setState).not.toHaveBeenCalled();
      expect(accessory.endpoint.getAttribute(Thermostat, 'systemMode')).toBe(Thermostat.SystemMode.FanOnly);
    });

    it('should set the fan speed from a percent, a speed and a fan mode', async () => {
      await writeAsController(accessory.endpoint, 'FanControl', 'percentSetting', 100);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ fanSpeed: 'level5' });
      expect(accessory.endpoint.getAttribute(FanControl, 'speedSetting')).toBe(6);

      await writeAsController(accessory.endpoint, 'FanControl', 'percentSetting', 10);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ fanSpeed: 'silent' });
      // 10 % snaps to the percent that stands for the first of six steps.
      expect(accessory.endpoint.getAttribute(FanControl, 'percentSetting')).toBe(16);
      expect(accessory.endpoint.getAttribute(FanControl, 'fanMode')).toBe(FanControl.FanMode.Low);

      await writeAsController(accessory.endpoint, 'FanControl', 'fanMode', FanControl.FanMode.Auto);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ fanSpeed: 'auto' });
      expect(accessory.endpoint.getAttribute(FanControl, 'fanMode')).toBe(FanControl.FanMode.Auto);

      await writeAsController(accessory.endpoint, 'FanControl', 'fanMode', FanControl.FanMode.High);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ fanSpeed: 'level5' });
    });

    it('should set the slowest speed when a controller turns the fan off', async () => {
      await writeAsController(accessory.endpoint, 'FanControl', 'percentSetting', 0);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ fanSpeed: 'silent' });
      expect(accessory.endpoint.getAttribute(FanControl, 'percentSetting')).toBe(16);
      expect(accessory.endpoint.getAttribute(FanControl, 'speedSetting')).toBe(1);
      expect(accessory.endpoint.getAttribute(FanControl, 'fanMode')).toBe(FanControl.FanMode.Low);

      await writeAsController(accessory.endpoint, 'FanControl', 'percentSetting', 100);
      await writeAsController(accessory.endpoint, 'FanControl', 'fanMode', FanControl.FanMode.Off);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ fanSpeed: 'silent' });
      expect(accessory.endpoint.getAttribute(FanControl, 'fanMode')).toBe(FanControl.FanMode.Low);
    });

    it('should swing on each axis from its own switch', async () => {
      if (accessory.verticalSwitch === undefined || accessory.horizontalSwitch === undefined) throw new Error('The swing switches are missing');
      await writeAsController(accessory.horizontalSwitch, 'OnOff', 'onOff', true);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ swingMode: 'horizontal' });

      await writeAsController(accessory.verticalSwitch, 'OnOff', 'onOff', true);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ swingMode: 'both' });
      expect(accessory.horizontalSwitch.getAttribute(OnOff, 'onOff')).toBe(true);

      await writeAsController(accessory.verticalSwitch, 'OnOff', 'onOff', false);
      await writeAsController(accessory.horizontalSwitch, 'OnOff', 'onOff', false);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenCalledTimes(3);
      expect(client.setState).toHaveBeenLastCalledWith({ swingMode: 'off' });

      accessory.verticalSwitch.eventsOf('onOff').onOff$Changed?.emit(true, false, offline);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenCalledTimes(3);
    });

    it('should send the writes of a controller together after the command delay', async () => {
      await writeTogetherAsController(accessory.endpoint, [
        ['Thermostat', 'systemMode', Thermostat.SystemMode.Cool],
        ['Thermostat', 'occupiedCoolingSetpoint', 2100],
        ['FanControl', 'percentSetting', 50],
      ]);
      expect(client.setState).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(client.setState).toHaveBeenCalled(), { timeout: 5000 });
      expect(client.setState).toHaveBeenCalledTimes(1);
      expect(client.setState).toHaveBeenCalledWith({ power: true, mode: 'cool', targetTemperatureInC: 21, fanSpeed: 'level2' });
      await accessory.refresh();
      expect(accessory.endpoint.getAttribute(Thermostat, 'occupiedCoolingSetpoint')).toBe(2100);
    });

    it('should not overwrite what a controller wrote while the unit was answering', async () => {
      let release: () => void = () => {};
      client.getSensors.mockImplementationOnce(
        async (): Promise<DaikinSensors> =>
          new Promise((resolve) => {
            release = (): void => resolve({ ...client.sensors });
          }),
      );
      const reading = accessory.refresh();
      await vi.waitFor(() => expect(client.getSensors).toHaveBeenCalled());
      await writeAsController(accessory.endpoint, 'FanControl', 'percentSetting', 100);
      release();
      expect(await reading).toBe(true);
      // The read did not put 50 % back before the command was sent.
      expect(accessory.endpoint.getAttribute(FanControl, 'percentSetting')).toBe(100);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenCalledWith({ fanSpeed: 'level5' });
    });

    it('should log a command the unit did not take and read its state back', async () => {
      client.setState.mockRejectedValueOnce(new DaikinError('Daikin command failed (ret=PARAM NG)', 502));
      client.setState.mockRejectedValueOnce('no reason');
      await writeAsController(accessory.endpoint, 'Thermostat', 'occupiedCoolingSetpoint', 2800);
      await accessory.flushCommands();
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('ret=PARAM NG'));
      expect(accessory.endpoint.getAttribute(Thermostat, 'occupiedCoolingSetpoint')).toBe(2100);
      await writeAsController(accessory.endpoint, 'Thermostat', 'occupiedCoolingSetpoint', 2800);
      await accessory.flushCommands();
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('no reason'));
    });

    it('should report the unit as unreachable after two failed reads, and as reachable when it answers again', async () => {
      client.getState.mockRejectedValueOnce(new DaikinError('timed out', 504));
      expect(await accessory.refresh()).toBe(false);
      expect(accessory.getStatus()).toMatchObject({ isReachable: true, lastError: 'timed out' });
      client.getState.mockRejectedValueOnce('gone');
      expect(await accessory.refresh()).toBe(false);
      expect(accessory.getStatus()).toMatchObject({ isReachable: false, lastError: 'gone' });
      expect(accessory.endpoint.getAttribute(BridgedDeviceBasicInformation, 'reachable')).toBe(false);
      expect(accessory.verticalSwitch?.getAttribute(BridgedDeviceBasicInformation, 'reachable')).toBe(false);
      client.getState.mockRejectedValueOnce(new DaikinError('timed out', 504));
      expect(await accessory.refresh()).toBe(false);

      expect(await accessory.refresh()).toBe(true);
      expect(accessory.getStatus()).toMatchObject({ isReachable: true, lastError: undefined });
      expect(accessory.endpoint.getAttribute(BridgedDeviceBasicInformation, 'reachable')).toBe(true);
    });

    it('should keep reading when its reachability cannot be written to Matter', async () => {
      const updateAttribute = vi.spyOn(accessory.endpoint, 'updateAttribute').mockRejectedValueOnce(new Error('endpoint is gone'));
      client.getState.mockRejectedValueOnce(new DaikinError('timed out', 504)).mockRejectedValueOnce(new DaikinError('timed out', 504));
      expect(await accessory.refresh()).toBe(false);
      expect(await accessory.refresh()).toBe(false);
      expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('endpoint is gone'));
      updateAttribute.mockRestore();
      expect(await accessory.refresh()).toBe(true);
    });

    it('should keep reading when a state cannot be written to Matter', async () => {
      const updateAttribute = vi.spyOn(accessory.endpoint, 'updateAttribute').mockRejectedValueOnce(new Error('constraint')).mockRejectedValueOnce('odd');
      expect(await accessory.refresh()).toBe(true);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('constraint'));
      expect(await accessory.refresh()).toBe(true);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('odd'));
      updateAttribute.mockRestore();
    });

    it('should use a new client after the address changed, and close the previous one', async () => {
      const next = createFakeClient({ power: false });
      client.close.mockRejectedValueOnce(new Error('already closed'));
      await accessory.updateConnection(createDeviceConfig({ host: '192.168.1.60' }), next);
      expect(client.close).toHaveBeenCalled();
      await accessory.refresh();
      expect(next.getState).toHaveBeenCalled();
      expect(accessory.endpoint.getAttribute(OnOff, 'onOff')).toBe(false);
      client = next;
    });

    it('should stop reading and sending once it is closed', async () => {
      await writeAsController(accessory.endpoint, 'OnOff', 'onOff', true);
      client.close.mockRejectedValueOnce('odd');
      await accessory.close();
      expect(client.close).toHaveBeenCalled();
      await writeAsController(accessory.endpoint, 'OnOff', 'onOff', false);
      await accessory.flushCommands();
      expect(await accessory.refresh()).toBe(false);
      expect(client.setState).not.toHaveBeenCalled();
    });
  });

  describe('a unit that only cools, with a percent fan and hidden swing', () => {
    let client: FakeClient;
    let accessory: DaikinAccessory;
    const capabilities = createCapabilities({
      modes: ['auto', 'dehumidify', 'cool', 'fan'],
      fanSpeeds: ['level1', 'level2', 'level3'],
      swingModes: ['off', 'vertical'],
      targetTemperaturesInC: { auto: null, dehumidify: null, cool: null, heat: null, fan: null },
    });

    it('should create a cooling thermostat with a percent fan and no switch', async () => {
      client = createFakeClient({ mode: 'auto', fanSpeed: 'auto', targetTemperatureInC: 40 }, capabilities);
      const config = createDeviceConfig({ name: 'Bedroom', fanControl: 'percent', swingControl: 'hidden', swingModeWhenHidden: 'vertical' });
      accessory = new DaikinAccessory({ config, capabilities, client, log, vendorId });
      expect(accessory.endpoints).toHaveLength(1);
      await addAccessory(accessory);
      expect(accessory.endpoint.getAttribute(FanControl, 'fanModeSequence')).toBe(FanControl.FanModeSequence.OffLowMedHigh);
      expect(accessory.endpoint.hasAttributeServer(FanControl, 'speedMax')).toBe(false);
      expect(accessory.endpoint.hasAttributeServer(Thermostat, 'occupiedHeatingSetpoint')).toBe(false);
      // A unit that reports no range gets 16 to 32 °C.
      expect(accessory.endpoint.getAttribute(Thermostat, 'maxCoolSetpointLimit')).toBe(3200);
    });

    it('should show auto as cool, clamp a setpoint to the limits and leave a fan speed it cannot show', async () => {
      await accessory.refresh();
      expect(accessory.endpoint.getAttribute(Thermostat, 'systemMode')).toBe(Thermostat.SystemMode.Cool);
      expect(accessory.endpoint.getAttribute(Thermostat, 'occupiedCoolingSetpoint')).toBe(3200);
      expect(accessory.endpoint.getAttribute(FanControl, 'percentSetting')).toBe(0);
      client.state.fanSpeed = 'level2';
      await accessory.refresh();
      expect(accessory.endpoint.getAttribute(FanControl, 'percentSetting')).toBe(66);
      expect(accessory.endpoint.getAttribute(FanControl, 'fanMode')).toBe(FanControl.FanMode.Medium);
    });

    it('should set the slowest speed of a unit without auto when a controller turns the fan off', async () => {
      await writeAsController(accessory.endpoint, 'FanControl', 'percentSetting', 0);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenCalledExactlyOnceWith({ fanSpeed: 'level1', swingMode: 'vertical' });
      expect(accessory.endpoint.getAttribute(FanControl, 'percentSetting')).toBe(33);
      expect(accessory.endpoint.getAttribute(FanControl, 'fanMode')).toBe(FanControl.FanMode.Low);
    });

    it('should send the fixed swing mode with every command', async () => {
      await writeAsController(accessory.endpoint, 'FanControl', 'percentSetting', 20);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ fanSpeed: 'level1', swingMode: 'vertical' });

      accessory.updateConfig(createDeviceConfig({ name: 'Bedroom', fanControl: 'percent', swingControl: 'hidden', swingModeWhenHidden: 'both' }));
      await writeAsController(accessory.endpoint, 'OnOff', 'onOff', false);
      await accessory.flushCommands();
      // The unit does not swing on both axes, so the fixed mode is left out.
      expect(client.setState).toHaveBeenLastCalledWith({ power: false });
      await accessory.close();
    });
  });

  describe('a unit that only heats, with a hidden fan', () => {
    it('should create a heating thermostat and send the fixed fan speed with every command', async () => {
      const capabilities = createCapabilities({ modes: ['heat', 'fan'], fanSpeeds: ['auto', 'level1'], swingModes: [] });
      const client = createFakeClient({ mode: 'heat', targetTemperatureInC: 20, swingMode: 'off' }, capabilities);
      const config = createDeviceConfig({ name: 'Study', fanControl: 'hidden', fanSpeedWhenHidden: 'level1' });
      const accessory = new DaikinAccessory({ config, capabilities, client, log, vendorId });
      expect(accessory.endpoints).toHaveLength(1);
      await addAccessory(accessory);
      expect(accessory.endpoint.hasClusterServer(FanControl)).toBe(false);
      expect(accessory.endpoint.hasAttributeServer(Thermostat, 'occupiedCoolingSetpoint')).toBe(false);
      await accessory.refresh();
      expect(accessory.endpoint.getAttribute(Thermostat, 'occupiedHeatingSetpoint')).toBe(2000);

      await writeAsController(accessory.endpoint, 'Thermostat', 'occupiedHeatingSetpoint', 2100);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ targetTemperatureInC: 21, fanSpeed: 'level1' });

      accessory.updateConfig(createDeviceConfig({ name: 'Study', fanControl: 'hidden', fanSpeedWhenHidden: 'level5' }));
      await writeAsController(accessory.endpoint, 'Thermostat', 'occupiedHeatingSetpoint', 2200);
      await accessory.flushCommands();
      // The unit has no level5, so only the setpoint is sent.
      expect(client.setState).toHaveBeenLastCalledWith({ targetTemperatureInC: 22 });
      await accessory.close();
    });
  });

  describe('a unit with switches for the dry and fan modes', () => {
    let client: FakeClient;
    let accessory: DaikinAccessory;

    it('should create one switch for each mode that is asked for and that the unit has', async () => {
      client = createFakeClient();
      const config = createDeviceConfig({ name: 'Den', fanControl: 'hidden', swingControl: 'hidden', modeControl: 'switches', modeSwitches: ['dehumidify', 'fan'] });
      accessory = new DaikinAccessory({ config, capabilities: createCapabilities(), client, log, vendorId });
      expect(accessory.endpoints).toHaveLength(3);
      expect(accessory.dryModeSwitch?.deviceName).toBe('Den Dry Mode');
      expect(accessory.fanModeSwitch?.deviceName).toBe('Den Fan Mode');
      await addAccessory(accessory);
      await accessory.refresh();
      expect(accessory.dryModeSwitch?.getAttribute(OnOff, 'onOff')).toBe(false);
      expect(accessory.fanModeSwitch?.getAttribute(OnOff, 'onOff')).toBe(false);

      const withoutDry = createCapabilities({ modes: ['cool', 'heat', 'fan'] });
      const other = new DaikinAccessory({ config: { ...config, name: 'Loft' }, capabilities: withoutDry, client: createFakeClient(), log, vendorId });
      expect(other.dryModeSwitch).toBeUndefined();
      expect(other.fanModeSwitch).toBeDefined();
    });

    it('should put the unit in a mode from its switch, and show which mode the unit is in', async () => {
      if (accessory.dryModeSwitch === undefined || accessory.fanModeSwitch === undefined) throw new Error('The mode switches are missing');
      client.state.power = false;
      await accessory.refresh();
      await writeAsController(accessory.dryModeSwitch, 'OnOff', 'onOff', true);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ power: true, mode: 'dehumidify' });
      expect(accessory.endpoint.getAttribute(Thermostat, 'systemMode')).toBe(Thermostat.SystemMode.Dry);
      expect(accessory.fanModeSwitch.getAttribute(OnOff, 'onOff')).toBe(false);

      await writeAsController(accessory.fanModeSwitch, 'OnOff', 'onOff', true);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ power: true, mode: 'fan' });
      expect(accessory.fanModeSwitch.getAttribute(OnOff, 'onOff')).toBe(true);
      expect(accessory.dryModeSwitch.getAttribute(OnOff, 'onOff')).toBe(false);
    });

    it('should go back to cooling when the switch of the current mode is turned off', async () => {
      if (accessory.dryModeSwitch === undefined || accessory.fanModeSwitch === undefined) throw new Error('The mode switches are missing');
      await writeAsController(accessory.fanModeSwitch, 'OnOff', 'onOff', false);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ mode: 'cool' });
      expect(accessory.endpoint.getAttribute(Thermostat, 'systemMode')).toBe(Thermostat.SystemMode.Cool);
      expect(accessory.endpoint.getAttribute(OnOff, 'onOff')).toBe(true);

      // Turned on and off again before anything was sent: the unit ends up cooling.
      await writeAsController(accessory.dryModeSwitch, 'OnOff', 'onOff', true);
      await writeAsController(accessory.dryModeSwitch, 'OnOff', 'onOff', false);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ power: true, mode: 'cool' });
    });

    it('should send nothing when a switch is turned off after the unit left its mode, and show a unit that is off as off', async () => {
      if (accessory.dryModeSwitch === undefined) throw new Error('The dry mode switch is missing');
      await writeAsController(accessory.dryModeSwitch, 'OnOff', 'onOff', false);
      await accessory.flushCommands();
      expect(client.setState).not.toHaveBeenCalled();

      Object.assign(client.state, { power: false, mode: 'dehumidify' });
      await accessory.refresh();
      expect(accessory.dryModeSwitch.getAttribute(OnOff, 'onOff')).toBe(false);
      await accessory.close();
    });

    it('should go back to heating on a unit that only heats', async () => {
      const capabilities = createCapabilities({ modes: ['heat', 'fan'], swingModes: [], fanSpeeds: [] });
      const heater = createFakeClient({ mode: 'fan', targetTemperatureInC: null, swingMode: 'off' }, capabilities);
      const warm = new DaikinAccessory({
        config: createDeviceConfig({ name: 'Shed', modeControl: 'switches', modeSwitches: ['fan'] }),
        capabilities,
        client: heater,
        log,
        vendorId,
      });
      if (warm.fanModeSwitch === undefined) throw new Error('The fan mode switch is missing');
      await addAccessory(warm);
      await warm.refresh();
      expect(warm.fanModeSwitch.getAttribute(OnOff, 'onOff')).toBe(true);
      await writeAsController(warm.fanModeSwitch, 'OnOff', 'onOff', false);
      await warm.flushCommands();
      expect(heater.setState).toHaveBeenLastCalledWith({ mode: 'heat' });
      await warm.close();
    });
  });

  describe('a unit with a switch for the auto fan speed', () => {
    let client: FakeClient;
    let accessory: DaikinAccessory;

    it('should create the switch on a unit that has an auto fan speed, and show whether the fan is on auto', async () => {
      client = createFakeClient({ fanSpeed: 'auto' });
      const config = createDeviceConfig({ name: 'Nook', macAddress: 'A4:08:EA:CC:91:D4', swingControl: 'hidden', fanAutoControl: 'switch' });
      accessory = new DaikinAccessory({ config, capabilities: createCapabilities(), client, log, vendorId });
      expect(accessory.endpoints).toHaveLength(2);
      expect(accessory.fanAutoSwitch?.deviceName).toBe('Nook Auto Fan');
      await addAccessory(accessory);
      // The switch is beside the fan mode Auto.
      expect(accessory.endpoint.getAttribute(FanControl, 'fanModeSequence')).toBe(FanControl.FanModeSequence.OffLowMedHighAuto);
      await accessory.refresh();
      expect(accessory.fanAutoSwitch?.getAttribute(OnOff, 'onOff')).toBe(true);

      const manualOnly = createCapabilities({ fanSpeeds: ['level1', 'level2'] });
      expect(new DaikinAccessory({ config: { ...config, name: 'Manual' }, capabilities: manualOnly, client: createFakeClient(), log, vendorId }).fanAutoSwitch).toBeUndefined();
    });

    it('should go to a middle speed when auto is turned off and the fan was never seen at a speed of its own', async () => {
      if (accessory.fanAutoSwitch === undefined) throw new Error('The auto fan switch is missing');
      await writeAsController(accessory.fanAutoSwitch, 'OnOff', 'onOff', false);
      await accessory.flushCommands();
      // The fourth of silent, level1 to level5.
      expect(client.setState).toHaveBeenLastCalledWith({ fanSpeed: 'level3' });
      expect(accessory.fanAutoSwitch.getAttribute(OnOff, 'onOff')).toBe(false);
      expect(accessory.endpoint.getAttribute(FanControl, 'fanMode')).toBe(FanControl.FanMode.Medium);
    });

    it('should set the fan to auto, and back to the speed it last ran at', async () => {
      if (accessory.fanAutoSwitch === undefined) throw new Error('The auto fan switch is missing');
      client.state.fanSpeed = 'level5';
      await accessory.refresh();
      await writeAsController(accessory.fanAutoSwitch, 'OnOff', 'onOff', true);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ fanSpeed: 'auto' });
      expect(accessory.fanAutoSwitch.getAttribute(OnOff, 'onOff')).toBe(true);
      expect(accessory.endpoint.getAttribute(FanControl, 'fanMode')).toBe(FanControl.FanMode.Auto);
      expect(accessory.endpoint.getAttribute(FanControl, 'percentSetting')).toBeNull();

      await writeAsController(accessory.fanAutoSwitch, 'OnOff', 'onOff', false);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ fanSpeed: 'level5' });
    });

    it('should send nothing when auto is turned off while the fan is not on auto', async () => {
      if (accessory.fanAutoSwitch === undefined) throw new Error('The auto fan switch is missing');
      await writeAsController(accessory.fanAutoSwitch, 'OnOff', 'onOff', false);
      await accessory.flushCommands();
      expect(client.setState).not.toHaveBeenCalled();
      await accessory.close();
    });
  });

  describe('a unit with the auto fan speed as a step', () => {
    let client: FakeClient;
    let accessory: DaikinAccessory;

    it('should put auto below the speeds of the unit, in place of the fan mode Auto', async () => {
      client = createFakeClient({ fanSpeed: 'auto' });
      accessory = new DaikinAccessory({
        config: createDeviceConfig({ name: 'Attic', swingControl: 'hidden', fanAutoControl: 'firstStep' }),
        capabilities: createCapabilities(),
        client,
        log,
        vendorId,
      });
      await addAccessory(accessory);
      // Auto, then silent and level1 to level5.
      expect(accessory.endpoint.getAttribute(FanControl, 'speedMax')).toBe(7);
      expect(accessory.endpoint.getAttribute(FanControl, 'fanModeSequence')).toBe(FanControl.FanModeSequence.OffLowMedHigh);
      await accessory.refresh();
      expect(accessory.endpoint.getAttribute(FanControl, 'percentSetting')).toBe(14);
      expect(accessory.endpoint.getAttribute(FanControl, 'speedCurrent')).toBe(1);
      client.state.fanSpeed = 'silent';
      await accessory.refresh();
      expect(accessory.endpoint.getAttribute(FanControl, 'percentSetting')).toBe(28);
      expect(accessory.endpoint.getAttribute(FanControl, 'speedCurrent')).toBe(2);
    });

    it('should set auto from the first step, and a speed of the unit from the others', async () => {
      await writeAsController(accessory.endpoint, 'FanControl', 'percentSetting', 10);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ fanSpeed: 'auto' });
      expect(accessory.endpoint.getAttribute(FanControl, 'percentSetting')).toBe(14);

      await writeAsController(accessory.endpoint, 'FanControl', 'percentSetting', 100);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ fanSpeed: 'level5' });

      // Off is the first step, which is auto here.
      await writeAsController(accessory.endpoint, 'FanControl', 'percentSetting', 0);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ fanSpeed: 'auto' });
      expect(accessory.endpoint.getAttribute(FanControl, 'percentSetting')).toBe(14);
      await accessory.close();
    });

    it('should put auto above the speeds of the unit, at 100 %', async () => {
      client = createFakeClient({ fanSpeed: 'auto' });
      const config = createDeviceConfig({ name: 'Conservatory', fanControl: 'percent', swingControl: 'hidden', fanAutoControl: 'lastStep' });
      accessory = new DaikinAccessory({ config, capabilities: createCapabilities(), client, log, vendorId });
      expect(accessory.endpoints).toHaveLength(1);
      await addAccessory(accessory);
      expect(accessory.endpoint.getAttribute(FanControl, 'fanModeSequence')).toBe(FanControl.FanModeSequence.OffLowMedHigh);
      await accessory.refresh();
      expect(accessory.endpoint.getAttribute(FanControl, 'percentSetting')).toBe(100);

      await writeAsController(accessory.endpoint, 'FanControl', 'percentSetting', 50);
      await accessory.flushCommands();
      // The fourth of silent, level1 to level5 and auto.
      expect(client.setState).toHaveBeenLastCalledWith({ fanSpeed: 'level3' });

      await writeAsController(accessory.endpoint, 'FanControl', 'percentSetting', 100);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ fanSpeed: 'auto' });
      await accessory.close();
    });
  });

  describe('a unit with switches for its special modes', () => {
    const specialModes = { auto: [], dehumidify: [], cool: ['powerful', 'econo', 'streamer'], heat: ['powerful', 'streamer'], fan: ['streamer'] } as const;
    const capabilities = createCapabilities({ specialModes });
    const config = createDeviceConfig({ name: 'Suite', fanControl: 'hidden', swingControl: 'hidden', specialModeSwitches: ['powerful', 'econo'] });
    let client: FakeClient;
    let accessory: DaikinAccessory;

    it('should create a switch for each special mode that is asked for, on either adapter', async () => {
      client = createFakeClient({ specialModes: ['econo'] }, capabilities);
      accessory = new DaikinAccessory({ config, capabilities, client, log, vendorId });
      expect(accessory.endpoints).toHaveLength(3);
      expect([...accessory.specialModeSwitches.keys()]).toEqual(['powerful', 'econo']);
      expect(accessory.specialModeSwitches.get('powerful')?.deviceName).toBe('Suite Powerful');
      expect(accessory.specialModeSwitches.get('econo')?.deviceName).toBe('Suite Econo');
      await addAccessory(accessory);
      await accessory.refresh();
      expect(accessory.specialModeSwitches.get('powerful')?.getAttribute(OnOff, 'onOff')).toBe(false);
      expect(accessory.specialModeSwitches.get('econo')?.getAttribute(OnOff, 'onOff')).toBe(true);

      const dsiot = new DaikinAccessory({ config: { ...config, name: 'Annex', protocol: 'dsiot' }, capabilities, client: createFakeClient({}, capabilities), log, vendorId });
      expect([...dsiot.specialModeSwitches.keys()]).toEqual(['powerful', 'econo']);
    });

    it('should turn a special mode on and off, each with a request of its own after the state', async () => {
      const powerful = accessory.specialModeSwitches.get('powerful');
      const econo = accessory.specialModeSwitches.get('econo');
      if (powerful === undefined || econo === undefined) throw new Error('The special mode switches are missing');
      await writeAsController(powerful, 'OnOff', 'onOff', true);
      await writeAsController(econo, 'OnOff', 'onOff', false);
      await writeAsController(accessory.endpoint, 'Thermostat', 'occupiedCoolingSetpoint', 2200);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenCalledWith({ targetTemperatureInC: 22 });
      expect(client.setSpecialMode.mock.calls).toEqual([
        ['powerful', true],
        ['econo', false],
      ]);
      expect(client.setState.mock.invocationCallOrder[0]).toBeLessThan(client.setSpecialMode.mock.invocationCallOrder[0] ?? 0);
      expect(powerful.getAttribute(OnOff, 'onOff')).toBe(true);
      expect(econo.getAttribute(OnOff, 'onOff')).toBe(false);
    });

    it('should not turn on a special mode the unit does not take in its mode', async () => {
      const econo = accessory.specialModeSwitches.get('econo');
      if (econo === undefined) throw new Error('The econo switch is missing');
      await writeAsController(accessory.endpoint, 'Thermostat', 'systemMode', Thermostat.SystemMode.Heat);
      await writeAsController(econo, 'OnOff', 'onOff', true);
      await accessory.flushCommands();
      expect(client.setSpecialMode).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith('"Suite" does not take Econo in heat mode: the request is ignored');
      expect(econo.getAttribute(OnOff, 'onOff')).toBe(false);
    });

    it('should log a special mode the unit did not take', async () => {
      const powerful = accessory.specialModeSwitches.get('powerful');
      if (powerful === undefined) throw new Error('The powerful switch is missing');
      client.setSpecialMode.mockRejectedValueOnce(new DaikinError('Daikin command failed (ret=PARAM NG)', 502));
      await writeAsController(powerful, 'OnOff', 'onOff', false);
      await accessory.flushCommands();
      expect(log.error).toHaveBeenCalledWith('"Suite" did not turn Powerful off: Daikin command failed (ret=PARAM NG)');
      expect(powerful.getAttribute(OnOff, 'onOff')).toBe(true);
      await accessory.close();
    });

    it('should not turn on a special mode before the unit said which mode it is in', async () => {
      const early = new DaikinAccessory({ config: { ...config, name: 'Early', macAddress: macOf('Early') }, capabilities, client, log, vendorId });
      const powerful = early.specialModeSwitches.get('powerful');
      if (powerful === undefined) throw new Error('The powerful switch is missing');
      await addAccessory(early);
      await writeAsController(powerful, 'OnOff', 'onOff', true);
      await early.flushCommands();
      expect(log.warn).toHaveBeenCalledWith('"Early" does not take Powerful in its current mode: the request is ignored');
      expect(client.setSpecialMode).not.toHaveBeenCalled();
      await early.close();
    });
  });

  describe('a unit whose fan is a device of its own', () => {
    it('should put the fan control on a fan, and none on the air conditioner', async () => {
      const client = createFakeClient();
      const config = createDeviceConfig({ name: 'Porch', swingControl: 'hidden', hasSeparateFan: true });
      const accessory = new DaikinAccessory({ config, capabilities: createCapabilities(), client, log, vendorId });
      expect(accessory.endpoints).toHaveLength(2);
      expect(accessory.fan?.deviceName).toBe('Porch Fan');
      expect(accessory.endpoint.hasClusterServer(FanControl)).toBe(false);
      await addAccessory(accessory);
      await accessory.refresh();
      // level3 is the fourth of silent, level1 to level5.
      expect(accessory.fan?.getAttribute(FanControl, 'percentSetting')).toBe(66);
      expect(accessory.fan?.getAttribute(FanControl, 'speedCurrent')).toBe(4);
      expect(accessory.fan?.getAttribute(BridgedDeviceBasicInformation, 'reachable')).toBe(true);

      if (accessory.fan === undefined) throw new Error('The fan is missing');
      await writeAsController(accessory.fan, 'FanControl', 'percentSetting', 100);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenCalledWith({ fanSpeed: 'level5' });
      expect(accessory.fan.getAttribute(FanControl, 'percentSetting')).toBe(100);

      // It is on and off with the air conditioner, and shows the speed the unit holds, also while the unit is off.
      expect(accessory.fan.getAttribute(OnOff, 'onOff')).toBe(true);
      client.state.power = false;
      await accessory.refresh();
      expect(accessory.endpoint.getAttribute(OnOff, 'onOff')).toBe(false);
      expect(accessory.fan.getAttribute(OnOff, 'onOff')).toBe(false);
      expect(accessory.fan.getAttribute(FanControl, 'percentSetting')).toBe(100);
      await accessory.close();
    });

    it('should turn the unit on and off from the fan', async () => {
      const client = createFakeClient();
      const config = createDeviceConfig({ name: 'Gazebo', swingControl: 'hidden', hasSeparateFan: true });
      const accessory = new DaikinAccessory({ config, capabilities: createCapabilities(), client, log, vendorId });
      await addAccessory(accessory);
      await accessory.refresh();
      if (accessory.fan === undefined) throw new Error('The fan is missing');
      await writeAsController(accessory.fan, 'OnOff', 'onOff', false);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ power: false });
      expect(accessory.endpoint.getAttribute(OnOff, 'onOff')).toBe(false);

      await writeAsController(accessory.fan, 'OnOff', 'onOff', true);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ power: true });
      expect(accessory.endpoint.getAttribute(OnOff, 'onOff')).toBe(true);
      expect(accessory.fan.getAttribute(OnOff, 'onOff')).toBe(true);

      accessory.fan.eventsOf('onOff').onOff$Changed?.emit(false, true, offline);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenCalledTimes(2);

      // An app drags the fan to 0 to turn it off: the unit keeps its speed.
      await writeTogetherAsController(accessory.fan, [
        ['FanControl', 'percentSetting', 0],
        ['OnOff', 'onOff', false],
      ]);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ power: false });
      expect(client.state.fanSpeed).toBe('level3');
      await accessory.close();
    });

    it('should have no fan when the fan speed is not shown', () => {
      const config = createDeviceConfig({ name: 'Hall', fanControl: 'hidden', swingControl: 'hidden', hasSeparateFan: true });
      const accessory = new DaikinAccessory({ config, capabilities: createCapabilities(), client: createFakeClient(), log, vendorId });
      expect(accessory.endpoints).toHaveLength(1);
      expect(accessory.fan).toBeUndefined();
    });
  });

  describe('a unit that gives its humidity and its outdoor temperature', () => {
    const config = createDeviceConfig({ name: 'Roof', fanControl: 'hidden', swingControl: 'hidden' });

    it('should show the humidity on the air conditioner and the outdoor temperature on a sensor of its own', async () => {
      const client = createFakeClient();
      client.sensors = { indoorTemperatureInC: 26.5, outdoorTemperatureInC: 31, indoorHumidityInPercent: 60 };
      const reportedSensors = { hasHumidity: true, hasOutdoorTemperature: true };
      const accessory = new DaikinAccessory({ config, capabilities: createCapabilities(), reportedSensors, client, log, vendorId });
      expect(accessory.endpoints).toHaveLength(2);
      expect(accessory.outdoorTemperatureSensor?.deviceName).toBe('Roof Outdoor Temperature');
      await addAccessory(accessory);
      // Neither has a value before the unit is read.
      expect(accessory.endpoint.getAttribute(RelativeHumidityMeasurement, 'measuredValue')).toBeNull();
      expect(accessory.outdoorTemperatureSensor?.getAttribute(TemperatureMeasurement, 'measuredValue')).toBeNull();
      await accessory.refresh();
      expect(accessory.endpoint.getAttribute(RelativeHumidityMeasurement, 'measuredValue')).toBe(6000);
      expect(accessory.outdoorTemperatureSensor?.getAttribute(TemperatureMeasurement, 'measuredValue')).toBe(3100);
      expect(accessory.outdoorTemperatureSensor?.getAttribute(BridgedDeviceBasicInformation, 'reachable')).toBe(true);
      expect(accessory.getNewlyReportedSensors()).toBeUndefined();

      // A reading that stops coming keeps its place, without a value.
      client.sensors = { indoorTemperatureInC: 26.5, outdoorTemperatureInC: null, indoorHumidityInPercent: null };
      await accessory.refresh();
      expect(accessory.endpoint.getAttribute(RelativeHumidityMeasurement, 'measuredValue')).toBeNull();
      expect(accessory.outdoorTemperatureSensor?.getAttribute(TemperatureMeasurement, 'measuredValue')).toBeNull();
      expect(accessory.getNewlyReportedSensors()).toBeUndefined();
      await accessory.close();
    });

    it('should tell when the unit gives a reading its endpoints were not built for', async () => {
      const client = createFakeClient();
      const accessory = new DaikinAccessory({ config: { ...config, name: 'Cellar', macAddress: macOf('Cellar') }, capabilities: createCapabilities(), client, log, vendorId });
      expect(accessory.endpoints).toHaveLength(1);
      expect(accessory.endpoint.hasClusterServer(RelativeHumidityMeasurement)).toBe(false);
      await addAccessory(accessory);
      // Nothing is known before the unit is read, and the thermostat shows no room temperature of its own making.
      expect(accessory.getNewlyReportedSensors()).toBeUndefined();
      await accessory.clearReadings();
      expect(accessory.endpoint.getAttribute(Thermostat, 'localTemperature')).toBeNull();
      await accessory.refresh();
      expect(accessory.getNewlyReportedSensors()).toBeUndefined();
      client.sensors.indoorHumidityInPercent = 55;
      await accessory.refresh();
      expect(accessory.getNewlyReportedSensors()).toEqual({ hasHumidity: true, hasOutdoorTemperature: false });
      await accessory.close();
    });

    it('should show the humidity on a sensor of its own too when asked to', async () => {
      const client = createFakeClient();
      client.sensors = { indoorTemperatureInC: 26.5, outdoorTemperatureInC: null, indoorHumidityInPercent: 60 };
      const separate = { ...config, name: 'Pantry', macAddress: macOf('Pantry'), hasSeparateHumiditySensor: true };
      const reportedSensors = { hasHumidity: true, hasOutdoorTemperature: false };
      const accessory = new DaikinAccessory({ config: separate, capabilities: createCapabilities(), reportedSensors, client, log, vendorId });
      expect(accessory.endpoints).toHaveLength(2);
      expect(accessory.humiditySensor?.deviceName).toBe('Pantry Humidity');
      expect(accessory.humiditySensor?.serialNumber).toBe(`${macOf('Pantry')}R`);
      // The air conditioner keeps the humidity, as it keeps the room temperature.
      expect(accessory.endpoint.hasClusterServer(RelativeHumidityMeasurement)).toBe(true);
      await addAccessory(accessory);
      expect(accessory.humiditySensor?.getAttribute(RelativeHumidityMeasurement, 'measuredValue')).toBeNull();
      await accessory.refresh();
      expect(accessory.humiditySensor?.getAttribute(RelativeHumidityMeasurement, 'measuredValue')).toBe(6000);
      expect(accessory.endpoint.getAttribute(RelativeHumidityMeasurement, 'measuredValue')).toBe(6000);
      expect(accessory.humiditySensor?.getAttribute(BridgedDeviceBasicInformation, 'reachable')).toBe(true);
      await accessory.close();
    });

    it('should have no outdoor sensor when none is asked for, and not take the outdoor temperature for a new reading', async () => {
      const client = createFakeClient();
      client.sensors = { indoorTemperatureInC: 26.5, outdoorTemperatureInC: 31, indoorHumidityInPercent: null };
      // A sensor of its own for a humidity the unit never gave is no sensor either.
      const withoutOutdoor = { ...config, name: 'Veranda', macAddress: macOf('Veranda'), hasOutdoorTemperatureSensor: false, hasSeparateHumiditySensor: true };
      const accessory = new DaikinAccessory({ config: withoutOutdoor, capabilities: createCapabilities(), client, log, vendorId });
      expect(accessory.endpoints).toHaveLength(1);
      await addAccessory(accessory);
      await accessory.refresh();
      expect(accessory.getNewlyReportedSensors()).toBeUndefined();
      await accessory.close();

      // Nor once the unit is known to give it.
      const reportedSensors = { hasHumidity: false, hasOutdoorTemperature: true };
      const known = new DaikinAccessory({ config: withoutOutdoor, capabilities: createCapabilities(), reportedSensors, client: createFakeClient(), log, vendorId });
      expect(known.outdoorTemperatureSensor).toBeUndefined();
      expect(known.humiditySensor).toBeUndefined();
    });
  });

  describe('a unit with a mode select and a swing select', () => {
    it('should show the mode and the swing of the unit, and send what a controller picks', async () => {
      const config = createDeviceConfig({ name: 'Workshop', modeControl: 'select', swingControl: 'select' });
      const capabilities = createCapabilities({ modes: ['cool', 'heat', 'dehumidify'], swingModes: ['off', 'vertical'] });
      const client = createFakeClient({ power: false, mode: 'heat', swingMode: 'vertical' });
      const accessory = new DaikinAccessory({ config, capabilities, reportedSensors: { hasHumidity: false, hasOutdoorTemperature: false }, client, log, vendorId });
      // The select takes the place of the swing switches.
      expect(accessory.endpoints).toEqual([accessory.endpoint, accessory.modeSelect, accessory.swingSelect]);
      expect(accessory.verticalSwitch).toBeUndefined();
      expect(accessory.modeSelect?.deviceName).toBe('Workshop Mode');
      expect(accessory.swingSelect?.deviceName).toBe('Workshop Swing');
      await addAccessory(accessory);
      // Off and the modes the unit takes, each with the same number whatever the unit takes.
      expect(accessory.modeSelect?.getAttribute(ModeSelect, 'description')).toBe('Mode');
      expect(accessory.modeSelect?.getAttribute(ModeSelect, 'supportedModes')).toEqual([
        { label: 'Off', mode: 0, semanticTags: [] },
        { label: 'Cool', mode: 2, semanticTags: [] },
        { label: 'Heat', mode: 3, semanticTags: [] },
        { label: 'Dry', mode: 4, semanticTags: [] },
      ]);
      expect(accessory.swingSelect?.getAttribute(ModeSelect, 'supportedModes')).toEqual([
        { label: 'Off', mode: 0, semanticTags: [] },
        { label: 'Vertical', mode: 1, semanticTags: [] },
      ]);

      // A unit that is off shows Off, as the system mode of the thermostat does.
      await accessory.refresh();
      expect(accessory.modeSelect?.getAttribute(ModeSelect, 'currentMode')).toBe(0);
      expect(accessory.swingSelect?.getAttribute(ModeSelect, 'currentMode')).toBe(1);

      if (accessory.modeSelect === undefined || accessory.swingSelect === undefined) throw new Error('A select is missing');
      // Picking a mode turns the unit on in it.
      await writeAsController(accessory.modeSelect, 'ModeSelect', 'currentMode', 4);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ power: true, mode: 'dehumidify' });
      expect(accessory.endpoint.getAttribute(Thermostat, 'systemMode')).toBe(Thermostat.SystemMode.Dry);
      expect(accessory.modeSelect.getAttribute(ModeSelect, 'currentMode')).toBe(4);
      // Picking Off turns the unit off.
      await writeAsController(accessory.modeSelect, 'ModeSelect', 'currentMode', 0);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ power: false });
      expect(accessory.endpoint.getAttribute(Thermostat, 'systemMode')).toBe(Thermostat.SystemMode.Off);
      await writeAsController(accessory.swingSelect, 'ModeSelect', 'currentMode', 0);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ swingMode: 'off' });
      expect(accessory.swingSelect.getAttribute(ModeSelect, 'currentMode')).toBe(0);

      // A swing mode the select does not list leaves it as it was.
      client.state.swingMode = 'both';
      await accessory.refresh();
      expect(accessory.swingSelect.getAttribute(ModeSelect, 'currentMode')).toBe(0);
      await accessory.close();
    });

    it('should tell the selects of a composed device apart by their tags, beside a switch', async () => {
      const config = createDeviceConfig({ name: 'Atrium', modeControl: 'select', swingControl: 'select', fanAutoControl: 'switch', isComposed: true });
      const accessory = new DaikinAccessory({ config, capabilities: createCapabilities(), client: createFakeClient(), log, vendorId });
      expect(accessory.endpoints).toEqual([accessory.endpoint]);
      expect(accessory.endpoint.getChildEndpoints()).toEqual([accessory.fanAutoSwitch, accessory.modeSelect, accessory.swingSelect]);
      // The switches and the selects are numbered each on their own.
      expect(accessory.fanAutoSwitch?.tagList).toEqual([{ ...CommonNumberTag.One, label: 'Auto Fan' }]);
      expect(accessory.modeSelect?.tagList).toEqual([{ ...CommonNumberTag.One, label: 'Mode' }]);
      expect(accessory.swingSelect?.tagList).toEqual([{ ...CommonNumberTag.Two, label: 'Swing' }]);
      expect(accessory.modeSelect?.deviceName).toBeUndefined();
      await addAccessory(accessory);
      expect(accessory.endpoint.getAttribute(Descriptor, 'partsList')).toHaveLength(3);
      await accessory.refresh();
      expect(accessory.modeSelect?.getAttribute(ModeSelect, 'currentMode')).toBe(2);
      expect(accessory.swingSelect?.getAttribute(ModeSelect, 'currentMode')).toBe(1);
      expect(accessory.fanAutoSwitch?.getAttribute(OnOff, 'onOff')).toBe(false);
      await accessory.close();
    });
  });

  describe('a unit whose fan, switches and humidity sensor are parts of the air conditioner', () => {
    const config = createDeviceConfig({
      name: 'Mezzanine',
      hasSeparateFan: true,
      modeControl: 'switches',
      modeSwitches: ['dehumidify'],
      hasSeparateHumiditySensor: true,
      isComposed: true,
    });
    const reportedSensors = { hasHumidity: true, hasOutdoorTemperature: true };

    it('should register the air conditioner and the outdoor sensor, and tell its parts apart by their tags', async () => {
      const client = createFakeClient();
      client.sensors = { indoorTemperatureInC: 26.5, outdoorTemperatureInC: 31, indoorHumidityInPercent: 60 };
      const accessory = new DaikinAccessory({ config, capabilities: createCapabilities(), reportedSensors, client, log, vendorId });
      const parts = [accessory.fan, accessory.verticalSwitch, accessory.horizontalSwitch, accessory.dryModeSwitch, accessory.humiditySensor];
      // The outdoor sensor is a device of its own, which can be put in a room other than that of the air conditioner.
      expect(accessory.endpoints).toEqual([accessory.endpoint, accessory.outdoorTemperatureSensor]);
      expect(accessory.endpoint.getChildEndpoints()).toEqual(parts);
      // A part has no name of its own. Each switch has a number, and says what it is in the label of that number.
      for (const part of parts) expect(part?.deviceName).toBeUndefined();
      expect(accessory.fan?.tagList).toBeUndefined();
      expect(accessory.humiditySensor?.tagList).toBeUndefined();
      expect(accessory.verticalSwitch?.tagList).toEqual([{ ...CommonNumberTag.One, label: 'Vertical Swing' }]);
      expect(accessory.horizontalSwitch?.tagList).toEqual([{ ...CommonNumberTag.Two, label: 'Horizontal Swing' }]);
      expect(accessory.dryModeSwitch?.tagList).toEqual([{ ...CommonNumberTag.Three, label: 'Dry Mode' }]);
      expect(accessory.outdoorTemperatureSensor?.deviceName).toBe('Mezzanine Outdoor Temperature');

      await addAccessory(accessory);
      expect(accessory.endpoint.getAttribute(Descriptor, 'partsList')).toHaveLength(5);
      expect(accessory.dryModeSwitch?.getAttribute(Descriptor, 'tagList')).toEqual([{ ...CommonNumberTag.Three, label: 'Dry Mode' }]);
      await accessory.refresh();
      expect(accessory.fan?.getAttribute(FanControl, 'percentSetting')).toBe(66);
      expect(accessory.verticalSwitch?.getAttribute(OnOff, 'onOff')).toBe(true);
      expect(accessory.horizontalSwitch?.getAttribute(OnOff, 'onOff')).toBe(false);
      expect(accessory.outdoorTemperatureSensor?.getAttribute(TemperatureMeasurement, 'measuredValue')).toBe(3100);
      expect(accessory.humiditySensor?.getAttribute(RelativeHumidityMeasurement, 'measuredValue')).toBe(6000);
      expect(accessory.endpoint.getAttribute(RelativeHumidityMeasurement, 'measuredValue')).toBe(6000);
      // The air conditioner says whether the unit is reachable for its parts, and the outdoor sensor for itself.
      expect(accessory.endpoint.getAttribute(BridgedDeviceBasicInformation, 'reachable')).toBe(true);
      expect(accessory.outdoorTemperatureSensor?.getAttribute(BridgedDeviceBasicInformation, 'reachable')).toBe(true);
      for (const part of parts) expect(part?.hasClusterServer(BridgedDeviceBasicInformation)).toBe(false);

      if (accessory.dryModeSwitch === undefined || accessory.fan === undefined) throw new Error('A part is missing');
      await writeAsController(accessory.dryModeSwitch, 'OnOff', 'onOff', true);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ power: true, mode: 'dehumidify' });
      expect(accessory.endpoint.getAttribute(Thermostat, 'systemMode')).toBe(Thermostat.SystemMode.Dry);
      await writeAsController(accessory.fan, 'FanControl', 'percentSetting', 100);
      await accessory.flushCommands();
      expect(client.setState).toHaveBeenLastCalledWith({ fanSpeed: 'level5' });
      await accessory.close();
    });

    it('should give a second device parts of its own', async () => {
      const other = { ...config, name: 'Gallery', macAddress: macOf('Gallery') };
      const accessory = new DaikinAccessory({ config: other, capabilities: createCapabilities(), reportedSensors, client: createFakeClient(), log, vendorId });
      await addAccessory(accessory);
      await accessory.refresh();
      expect(accessory.endpoint.getAttribute(Descriptor, 'partsList')).toHaveLength(5);
      expect(accessory.verticalSwitch?.getAttribute(OnOff, 'onOff')).toBe(true);
      await accessory.close();
    });
  });

  describe('fan sequences', () => {
    it('should offer Low and High to a unit with two speeds and auto, and High alone to a unit with one', async () => {
      const twoSpeeds = createCapabilities({ fanSpeeds: ['auto', 'level1', 'level5'], swingModes: ['off', 'horizontal'] });
      const two = new DaikinAccessory({ config: createDeviceConfig({ name: 'Two', fanControl: 'percent' }), capabilities: twoSpeeds, client: createFakeClient(), log, vendorId });
      expect(two.endpoints).toHaveLength(2);
      expect(two.verticalSwitch).toBeUndefined();
      await addAccessory(two);
      expect(two.endpoint.getAttribute(FanControl, 'fanModeSequence')).toBe(FanControl.FanModeSequence.OffLowHighAuto);
      // A switch works before the unit was ever read: the swing is taken to be off until then.
      if (two.horizontalSwitch === undefined) throw new Error('The horizontal swing switch is missing');
      const twoClient = createFakeClient();
      await two.updateConnection(createDeviceConfig({ name: 'Two', fanControl: 'percent' }), twoClient);
      await writeAsController(two.horizontalSwitch, 'OnOff', 'onOff', true);
      await two.flushCommands();
      expect(twoClient.setState).toHaveBeenCalledWith({ swingMode: 'horizontal' });

      const oneSpeed = createCapabilities({ fanSpeeds: ['level3'], swingModes: [] });
      const one = new DaikinAccessory({ config: createDeviceConfig({ name: 'One' }), capabilities: oneSpeed, client: createFakeClient(), log, vendorId });
      await addAccessory(one);
      expect(one.endpoint.getAttribute(FanControl, 'fanModeSequence')).toBe(FanControl.FanModeSequence.OffHigh);
      expect(one.endpoint.getAttribute(FanControl, 'speedMax')).toBe(1);
      await two.close();
      await one.close();
    });

    it('should expose no fan to a unit whose fan is not controllable', () => {
      const capabilities = createCapabilities({ fanSpeeds: [] });
      const accessory = new DaikinAccessory({ config: createDeviceConfig({ name: 'None' }), capabilities, client: createFakeClient(), log, vendorId });
      expect(accessory.endpoint.hasClusterServer(FanControl)).toBe(false);
    });
  });

  it('should read no fan speed from a fan control that holds no percent outside of Auto', () => {
    // Matter holds no percent in Auto alone, so this guards against a fan control that breaks the rule.
    const endpoint = { getAttribute: (_cluster: unknown, attribute: string) => (attribute === 'fanMode' ? FanControl.FanMode.Low : null) } as unknown as MatterbridgeEndpoint;
    expect(readFanSpeed(endpoint, ['level1', 'level2'])).toBeUndefined();
    // A fan speed that cannot be read is left out of the command.
    const pending = new PendingCommand();
    pending.requestFanSpeed();
    const unit = { state: undefined, capabilities: createCapabilities(), fanSteps: ['level1', 'level2'] as const, lastManualFanSpeed: undefined };
    expect(pending.take(unit, vi.fn()).control).toEqual({});
  });

  it('should refuse a unit that neither cools nor heats', () => {
    const capabilities = createCapabilities({ modes: ['fan'] });
    expect(() => new DaikinAccessory({ config: createDeviceConfig(), capabilities, client: createFakeClient(), log, vendorId })).toThrow('neither cools nor heats');
  });
});
