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
  const devices = [livingRoom, bedroom];
  // The adapter of the living room as it answers a search: its MAC address comes without colons.
  const adapter: DaikinDevice = { host: '192.168.1.50', protocol: 'classic', name: 'Living Room', macAddress: macOf('Living Room').replaceAll(':', '') };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should change nothing for a device whose adapter did not answer or answered as it is stored', () => {
    expect(getDiscoveredUpdate(livingRoom, devices, [], log)).toBeUndefined();
    expect(getDiscoveredUpdate(bedroom, devices, [adapter], log)).toBeUndefined();
    expect(getDiscoveredUpdate(livingRoom, devices, [adapter], log)).toBeUndefined();
  });

  it('should take the address, the name and the requirements the adapter has now', () => {
    const moved: DaikinDevice = { ...adapter, host: '192.168.1.77', name: ' Lounge ', usesHttps: true, requiresRegistration: true, requiresLocalPassword: true };
    expect(getDiscoveredUpdate(livingRoom, devices, [moved], log)).toEqual({
      ...livingRoom,
      host: '192.168.1.77',
      name: 'Lounge',
      usesHttps: true,
      requiresRegistration: true,
      requiresLocalPassword: true,
    });
  });

  it('should keep the stored name when the new one is taken or not valid', () => {
    expect(getDiscoveredUpdate(livingRoom, devices, [{ ...adapter, name: 'Bedroom' }], log)).toBeUndefined();
    expect(getDiscoveredUpdate(livingRoom, devices, [{ ...adapter, name: undefined, host: '192.168.1.77' }], log)).toEqual({ ...livingRoom, host: '192.168.1.77' });
  });

  it('should leave a device whose adapter speaks another protocol as it is, with a warning', () => {
    expect(getDiscoveredUpdate(livingRoom, devices, [{ ...adapter, protocol: 'dsiot', host: '192.168.1.77' }], log)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('now speaks dsiot instead of classic'));
  });

  it('should follow an Airbase adapter the search reports as classic, and keep its stored requirements', () => {
    const ducted = createDeviceConfig({ name: 'Ducted', host: '192.168.1.52', protocol: 'airbase' });
    const found: DaikinDevice = { host: '192.168.1.52', protocol: 'airbase', name: 'Ducted', macAddress: ducted.macAddress };
    expect(getDiscoveredUpdate(ducted, [ducted], [{ ...found, host: '192.168.1.78', usesHttps: true }], log)).toEqual({ ...ducted, host: '192.168.1.78', usesHttps: true });

    // The search could not ask the adapter which it is, and read its reply as a classic adapter's.
    const unconfirmed: DaikinDevice = { ...found, protocol: 'classic', host: '192.168.1.79', name: 'Upstairs', requiresRegistration: true, requiresLocalPassword: true };
    expect(getDiscoveredUpdate(ducted, [ducted], [unconfirmed], log)).toEqual({ ...ducted, host: '192.168.1.79', name: 'Upstairs' });
    expect(getDiscoveredUpdate(ducted, [ducted], [{ ...found, protocol: 'classic' }], log)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();

    expect(getDiscoveredUpdate(ducted, [ducted], [{ ...found, protocol: 'dsiot' }], log)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('now speaks dsiot instead of airbase'));
  });
});
