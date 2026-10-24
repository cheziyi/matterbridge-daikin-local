/**
 * @file vitest/platform/discovery.test.ts
 * @description This file contains the tests for what a search of the network changes about a stored device.
 * @author Calvin Che
 */

import type { DaikinDevice } from 'daikin-local-control';
import type { AnsiLogger } from 'matterbridge/logger';

import { getDiscoveredUpdate } from '../../src/platform/discovery.js';
import { createDeviceConfig, macOf } from '../fakeDaikin.js';

const warn = vi.fn();
const log = { warn } as unknown as AnsiLogger;

describe('discovery', () => {
  const livingRoom = createDeviceConfig();
  const bedroom = createDeviceConfig({ name: 'Bedroom', host: '192.168.1.51' });
  // The adapter of the living room as it answers a search: its MAC address comes without colons.
  const adapter: DaikinDevice = { host: '192.168.1.50', protocol: 'classic', name: 'Living Room', macAddress: macOf('Living Room').replaceAll(':', '') };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('should change nothing for a device whose adapter did not answer or answered as it is stored', () => {
    expect(getDiscoveredUpdate(livingRoom, [], log)).toBeUndefined();
    expect(getDiscoveredUpdate(bedroom, [adapter], log)).toBeUndefined();
    expect(getDiscoveredUpdate(livingRoom, [adapter], log)).toBeUndefined();
  });

  test('should take the address and the requirements the adapter has now, and keep the name of the device', () => {
    const moved: DaikinDevice = { ...adapter, host: '192.168.1.77', name: ' Lounge ', usesHttps: true, requiresRegistration: true, requiresLocalPassword: true };
    expect(getDiscoveredUpdate(livingRoom, [moved], log)).toEqual({
      ...livingRoom,
      host: '192.168.1.77',
      usesHttps: true,
      requiresRegistration: true,
      requiresLocalPassword: true,
    });
  });

  test('should change nothing for a device whose adapter answered under another name alone', () => {
    expect(getDiscoveredUpdate(livingRoom, [{ ...adapter, name: 'Bedroom' }], log)).toBeUndefined();
    expect(getDiscoveredUpdate(livingRoom, [{ ...adapter, name: undefined, host: '192.168.1.77' }], log)).toEqual({ ...livingRoom, host: '192.168.1.77' });
  });

  test('should leave a device whose adapter speaks another protocol as it is, with a warning', () => {
    expect(getDiscoveredUpdate(livingRoom, [{ ...adapter, protocol: 'dsiot', host: '192.168.1.77' }], log)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('now speaks dsiot instead of classic'));
  });

  test('should follow an Airbase adapter the search reports as classic, and keep its stored requirements', () => {
    const ducted = createDeviceConfig({ name: 'Ducted', host: '192.168.1.52', protocol: 'airbase' });
    const found: DaikinDevice = { host: '192.168.1.52', protocol: 'airbase', name: 'Ducted', macAddress: ducted.macAddress };
    expect(getDiscoveredUpdate(ducted, [{ ...found, host: '192.168.1.78', usesHttps: true }], log)).toEqual({ ...ducted, host: '192.168.1.78', usesHttps: true });

    // The search could not ask the adapter which it is, and read its reply as a classic adapter's.
    const unconfirmed: DaikinDevice = { ...found, protocol: 'classic', host: '192.168.1.79', name: 'Upstairs', requiresRegistration: true, requiresLocalPassword: true };
    expect(getDiscoveredUpdate(ducted, [unconfirmed], log)).toEqual({ ...ducted, host: '192.168.1.79' });
    expect(getDiscoveredUpdate(ducted, [{ ...found, protocol: 'classic' }], log)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();

    expect(getDiscoveredUpdate(ducted, [{ ...found, protocol: 'dsiot' }], log)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('now speaks dsiot instead of airbase'));
  });
});
