/**
 * @file vitest/config.test.ts
 * @description This file contains the tests for the plugin configuration model.
 * @author Calvin Che
 */

/* oxlint-disable unicorn/no-useless-undefined */

import {
  getUnreadableDevices,
  hasSameConnection,
  normalizeMacAddress,
  hasSameExposure,
  isValidHost,
  normalizeDeviceName,
  normalizeMaxStateAgeForCommand,
  normalizePollInterval,
  normalizeTerminalUuid,
  parseDeviceConfig,
  parseDeviceConfigs,
  toDaikinDevice,
} from '../src/config.js';
import { createDeviceConfig, macOf } from './fakeDaikin.js';

describe('config', () => {
  it('should accept a host name or an address with an optional port, and nothing else', () => {
    expect(isValidHost('192.168.1.50')).toBe(true);
    expect(isValidHost('192.168.1.50:8080')).toBe(true);
    expect(isValidHost('daikin-living.local')).toBe(true);
    expect(isValidHost('a')).toBe(true);
    expect(isValidHost('http://192.168.1.50')).toBe(false);
    expect(isValidHost('192.168.1.50/path')).toBe(false);
    expect(isValidHost('')).toBe(false);
    expect(isValidHost(42)).toBe(false);
  });

  it('should normalize a terminal uuid to 32 lower case digits, with or without dashes', () => {
    expect(normalizeTerminalUuid('0D120767-302B-4603-B5AE-916260815E4E')).toBe('0d120767302b4603b5ae916260815e4e');
    expect(normalizeTerminalUuid('0d120767302b4603b5ae916260815e4e')).toBe('0d120767302b4603b5ae916260815e4e');
    expect(normalizeTerminalUuid('not-a-uuid-not-a-uuid-not-a-uuid-xx')).toBeUndefined();
    expect(normalizeTerminalUuid('')).toBeUndefined();
    expect(normalizeTerminalUuid(undefined)).toBeUndefined();
  });

  it('should normalize a MAC address with or without separators', () => {
    expect(normalizeMacAddress('a408eacc91d4')).toBe('A4:08:EA:CC:91:D4');
    expect(normalizeMacAddress('A4:08:EA:CC:91:D4')).toBe('A4:08:EA:CC:91:D4');
    expect(normalizeMacAddress('a4-08-ea-cc-91-d4')).toBe('A4:08:EA:CC:91:D4');
    expect(normalizeMacAddress('A4:08:EA:CC:91')).toBeUndefined();
    expect(normalizeMacAddress('G4:08:EA:CC:91:D4')).toBeUndefined();
    expect(normalizeMacAddress(undefined)).toBeUndefined();
  });

  it('should trim a device name and refuse an empty or too long one', () => {
    expect(normalizeDeviceName('  Living Room ')).toBe('Living Room');
    expect(normalizeDeviceName('   ')).toBeUndefined();
    expect(normalizeDeviceName('x'.repeat(33))).toBeUndefined();
    expect(normalizeDeviceName(7)).toBeUndefined();
  });

  it('should clamp the poll interval to 2..3600 seconds and default to 5', () => {
    expect(normalizePollInterval(30)).toBe(30);
    expect(normalizePollInterval(1)).toBe(2);
    expect(normalizePollInterval(99999)).toBe(3600);
    expect(normalizePollInterval('30')).toBe(5);
    expect(normalizePollInterval(undefined)).toBe(5);
  });

  it('should clamp the state age for a command to 0..3600 seconds and default to 30', () => {
    expect(normalizeMaxStateAgeForCommand(10)).toBe(10);
    expect(normalizeMaxStateAgeForCommand(0)).toBe(0);
    expect(normalizeMaxStateAgeForCommand(-1)).toBe(0);
    expect(normalizeMaxStateAgeForCommand(99999)).toBe(3600);
    expect(normalizeMaxStateAgeForCommand('10')).toBe(30);
    expect(normalizeMaxStateAgeForCommand(undefined)).toBe(30);
  });

  it('should parse a device stored with only a name, an address, a protocol and a MAC address', () => {
    const device = createDeviceConfig();
    expect(parseDeviceConfig({ name: 'Living Room', host: '192.168.1.50', protocol: 'classic', macAddress: device.macAddress.toLowerCase() })).toEqual({
      ...device,
      hasOutdoorTemperatureSensor: false,
      isComposed: true,
    });
  });

  it('should keep every valid field of a stored device', () => {
    const stored = {
      name: 'Bedroom',
      host: '192.168.1.51',
      protocol: 'dsiot',
      requiresRegistration: true,
      usesHttps: true,
      requiresLocalPassword: true,
      localPassword: '1234',
      fanControl: 'hidden',
      fanSpeedWhenHidden: 'silent',
      swingControl: 'select',
      swingModeWhenHidden: 'both',
      hasDryModeSwitch: true,
      hasFanModeSwitch: true,
      hasFanAutoSwitch: true,
      hasModeSelect: true,
      hasSeparateFan: true,
      specialModeSwitches: ['powerful', 'streamer'],
      hasOutdoorTemperatureSensor: true,
      hasSeparateHumiditySensor: true,
      isComposed: true,
      macAddress: 'A4:08:EA:CC:91:D4',
    };
    expect(parseDeviceConfig(stored)).toEqual(stored);
    // The MAC address is stored in one form, and the special modes in one order.
    expect(parseDeviceConfig({ ...stored, macAddress: 'a408eacc91d4', specialModeSwitches: ['streamer', 'turbo', 'powerful'] })).toEqual(stored);
    expect(parseDeviceConfig({ ...stored, specialModeSwitches: 'powerful' })).toEqual({ ...stored, specialModeSwitches: [] });
  });

  it('should fall back to the defaults for fields that are not valid, and report each', () => {
    const device = createDeviceConfig({ name: 'A', host: 'h', hasOutdoorTemperatureSensor: false, isComposed: true });
    const stored = {
      name: 'A',
      host: 'h',
      protocol: 'classic',
      macAddress: device.macAddress,
      usesHttps: 'yes',
      localPassword: '',
      fanControl: 'fast',
      fanSpeedWhenHidden: 'level9',
      swingControl: 1,
      swingModeWhenHidden: null,
      hasModeSelect: 'yes',
      specialModeSwitches: ['turbo'],
    };
    expect(parseDeviceConfig(stored)).toEqual(device);

    const report = vi.fn();
    expect(parseDeviceConfig(stored, report)).toEqual(device);
    expect(report).toHaveBeenCalledTimes(8);
    expect(report).toHaveBeenCalledWith('"A" has the usesHttps "yes", which is not valid: false is used instead');
    expect(report).toHaveBeenCalledWith('"A" has the fanControl "fast", which is not valid: "steps" is used instead');
    expect(report).toHaveBeenCalledWith('"A" has the swingModeWhenHidden null, which is not valid: "keep" is used instead');
    expect(report).toHaveBeenCalledWith('"A" has special mode switches this version does not know, which are dropped: ["turbo"]');
    expect(report).toHaveBeenCalledWith('"A" has a child lock code that is not valid, which is ignored');

    report.mockClear();
    expect(parseDeviceConfig({ ...device, specialModeSwitches: 'powerful' }, report)).toEqual(device);
    expect(report).toHaveBeenCalledExactlyOnceWith('"A" has the specialModeSwitches "powerful", which is not valid: [] is used instead');

    // A setting that is stored as it should be, `keep` among them, is not reported.
    report.mockClear();
    expect(parseDeviceConfig({ ...device, localPassword: '1234' }, report)).toEqual({ ...device, localPassword: '1234' });
    expect(report).not.toHaveBeenCalled();
  });

  it('should refuse a device without a valid name, address, protocol or MAC address', () => {
    const device = createDeviceConfig();
    expect(parseDeviceConfig(undefined)).toBeUndefined();
    expect(parseDeviceConfig('Living Room')).toBeUndefined();
    expect(parseDeviceConfig({ ...device, name: '' })).toBeUndefined();
    expect(parseDeviceConfig({ ...device, host: 'http://h' })).toBeUndefined();
    expect(parseDeviceConfig({ ...device, protocol: 'modbus' })).toBeUndefined();
    expect(parseDeviceConfig({ ...device, macAddress: 'not a mac' })).toBeUndefined();
    // An address alone is not a device: the setup page stores a device once its adapter has said which one it is.
    expect(parseDeviceConfig({ host: '192.168.1.60' })).toBeUndefined();
  });

  it('should drop the devices that are wrong and report each', () => {
    const report = vi.fn();
    const stored = [createDeviceConfig(), { host: '192.168.1.60' }, createDeviceConfig({ host: '192.168.1.99' }), createDeviceConfig({ name: 'Bedroom' })];
    const devices = parseDeviceConfigs(stored, report);
    expect(devices.map((device) => `${device.name}@${device.host}`)).toEqual(['Living Room@192.168.1.50', 'Bedroom@192.168.1.50']);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledWith(expect.stringContaining('It stays in the configuration as it is'));
    expect(report).toHaveBeenCalledWith(expect.stringContaining('"Living Room"'));
    expect(parseDeviceConfigs([{ name: 'Broken' }, createDeviceConfig(), createDeviceConfig()])).toHaveLength(1);
    const twice = [
      createDeviceConfig({ macAddress: 'A4:08:EA:CC:91:D4' }),
      createDeviceConfig({ name: 'Lounge', macAddress: 'A4:08:EA:CC:91:D4' }),
      createDeviceConfig({ name: 'Den' }),
    ];
    expect(parseDeviceConfigs(twice, report).map((device) => device.name)).toEqual(['Living Room', 'Den']);
    expect(report).toHaveBeenCalledWith('"Lounge" has the MAC address of another stored device and is ignored');
    expect(parseDeviceConfigs('none')).toEqual([]);
  });

  it('should list the stored devices it cannot read until a device takes their place', () => {
    const living = createDeviceConfig();
    // A device as a later version might store it, one without the MAC address of its adapter, and no device at all.
    const fromLater = { ...createDeviceConfig({ name: 'Annex' }), protocol: 'later' };
    const incomplete = { name: 'Cellar', host: '192.168.1.98' };
    const stored = [living, fromLater, incomplete, 'junk'];
    expect(getUnreadableDevices(stored, [living])).toEqual([fromLater, incomplete, 'junk']);
    // Added again in the setup page: the adapter under another name, and a device under the same name.
    expect(getUnreadableDevices(stored, [living, createDeviceConfig({ name: 'Loft', macAddress: fromLater.macAddress })])).toEqual([incomplete, 'junk']);
    expect(getUnreadableDevices(stored, [living, createDeviceConfig({ name: 'Cellar' })])).toEqual([fromLater, 'junk']);
    expect(getUnreadableDevices('none', [living])).toEqual([]);
  });

  it('should convert a stored device to the device the client takes', () => {
    expect(toDaikinDevice(createDeviceConfig({ localPassword: '1234', requiresLocalPassword: true }))).toEqual({
      host: '192.168.1.50',
      protocol: 'classic',
      name: 'Living Room',
      macAddress: macOf('Living Room'),
      requiresRegistration: false,
      usesHttps: false,
      requiresLocalPassword: true,
    });
  });

  it('should compare the connection and the exposure of two devices', () => {
    const device = createDeviceConfig();
    expect(hasSameConnection(device, createDeviceConfig({ fanControl: 'hidden' }))).toBe(true);
    expect(hasSameConnection(device, createDeviceConfig({ host: '192.168.1.51' }))).toBe(false);
    expect(hasSameConnection(device, createDeviceConfig({ protocol: 'dsiot' }))).toBe(false);
    expect(hasSameConnection(device, createDeviceConfig({ requiresRegistration: true }))).toBe(false);
    expect(hasSameConnection(device, createDeviceConfig({ usesHttps: true }))).toBe(false);
    expect(hasSameConnection(device, createDeviceConfig({ requiresLocalPassword: true }))).toBe(false);
    expect(hasSameConnection(device, createDeviceConfig({ localPassword: '1234' }))).toBe(false);
    expect(hasSameExposure(device, createDeviceConfig({ host: '192.168.1.51', fanSpeedWhenHidden: 'auto' }))).toBe(true);
    expect(hasSameExposure(device, createDeviceConfig({ fanControl: 'percent' }))).toBe(false);
    expect(hasSameExposure(device, createDeviceConfig({ swingControl: 'hidden' }))).toBe(false);
    expect(hasSameExposure(device, createDeviceConfig({ hasDryModeSwitch: true }))).toBe(false);
    expect(hasSameExposure(device, createDeviceConfig({ hasFanModeSwitch: true }))).toBe(false);
    expect(hasSameExposure(device, createDeviceConfig({ hasFanAutoSwitch: true }))).toBe(false);
    expect(hasSameExposure(device, createDeviceConfig({ hasModeSelect: true }))).toBe(false);
    expect(hasSameExposure(device, createDeviceConfig({ swingControl: 'select' }))).toBe(false);
    expect(hasSameExposure(device, createDeviceConfig({ hasSeparateFan: true }))).toBe(false);
    expect(hasSameExposure(device, createDeviceConfig({ specialModeSwitches: ['econo'] }))).toBe(false);
    expect(hasSameExposure(device, createDeviceConfig({ hasOutdoorTemperatureSensor: false }))).toBe(false);
    expect(hasSameExposure(device, createDeviceConfig({ hasSeparateHumiditySensor: true }))).toBe(false);
    expect(hasSameExposure(device, createDeviceConfig({ isComposed: true }))).toBe(false);
    // A new name is a new name in Matter, so the device is built again.
    expect(hasSameExposure(device, createDeviceConfig({ name: 'Lounge' }))).toBe(false);
  });
});
