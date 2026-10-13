/**
 * @file vitest/setup/setupApi.test.ts
 * @description This file contains the tests for the REST API of the setup page.
 * @author Calvin Che
 */

/* oxlint-disable unicorn/no-useless-undefined */

import type { ProbeResult } from '../../src/setup/probe.js';
import { handleSetupRequest, parseDaikinDevice, type SetupPlatform } from '../../src/setup/setupApi.js';
import { createDeviceConfig } from '../fakeDaikin.js';

const state = { devices: [] };
const adapter = { host: '192.168.1.50', protocol: 'classic', name: 'Living Room' } as const;
const parsedAdapter = { ...adapter, requiresRegistration: false, usesHttps: false, requiresLocalPassword: false };
const ready: ProbeResult = { status: 'ready', device: parsedAdapter };

const platform = {
  getSetupState: vi.fn(async () => state),
  discoverForSetup: vi.fn(async () => [{ ...adapter, isConfigured: false, hasDuplicateName: false, needsRegistration: false }]),
  identify: vi.fn(async () => adapter),
  probe: vi.fn(async () => ready),
  register: vi.fn(async () => ready),
  saveDevice: vi.fn(async () => {}),
  removeDevice: vi.fn(async () => true),
} satisfies { [K in keyof SetupPlatform]: unknown };

describe('setupApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should read the adapter a request is about', () => {
    expect(parseDaikinDevice({ ...adapter, requiresRegistration: true, usesHttps: true, requiresLocalPassword: true })).toEqual({
      ...adapter,
      requiresRegistration: true,
      usesHttps: true,
      requiresLocalPassword: true,
    });
    expect(parseDaikinDevice({ host: '192.168.1.50', protocol: 'dsiot' })).toEqual({ ...parsedAdapter, protocol: 'dsiot', name: undefined });
    expect(parseDaikinDevice({ host: 'http://x', protocol: 'classic' })).toBeUndefined();
    expect(parseDaikinDevice({ host: '192.168.1.50', protocol: 'modbus' })).toBeUndefined();
    expect(parseDaikinDevice(undefined)).toBeUndefined();
  });

  it('should return the state', async () => {
    expect(await handleSetupRequest(platform, 'GET', 'state')).toEqual({ ok: true, state });
  });

  it('should leave a path it does not serve to Matterbridge', async () => {
    expect(await handleSetupRequest(platform, 'GET', 'nothing')).toBeUndefined();
    expect(await handleSetupRequest(platform, 'GET')).toBeUndefined();
    expect(await handleSetupRequest(platform, 'POST')).toBeUndefined();
    expect(await handleSetupRequest(platform, 'POST', 'nothing', {}, {})).toBeUndefined();
    expect(await handleSetupRequest(platform, 'PUT', 'state')).toBeUndefined();
    expect(await handleSetupRequest(platform, 'DELETE', 'state')).toBeUndefined();
  });

  it('should search the network', async () => {
    expect(await handleSetupRequest(platform, 'POST', 'discover')).toEqual({
      ok: true,
      devices: [{ ...adapter, isConfigured: false, hasDuplicateName: false, needsRegistration: false }],
    });
  });

  it('should look up an adapter by its address', async () => {
    expect(await handleSetupRequest(platform, 'POST', 'identify', {}, { host: '192.168.1.50' })).toEqual({ ok: true, device: adapter });
    platform.identify.mockResolvedValueOnce(undefined as unknown as typeof adapter);
    expect(await handleSetupRequest(platform, 'POST', 'identify', {}, { host: '192.168.1.99' })).toEqual({ ok: false, error: 'No Daikin adapter answered at 192.168.1.99' });
    expect(await handleSetupRequest(platform, 'POST', 'identify', {}, { host: 'http://192.168.1.50/' })).toMatchObject({ ok: false });
    expect(platform.identify).toHaveBeenCalledTimes(2);
  });

  it('should check an adapter, with or without a child lock code', async () => {
    expect(await handleSetupRequest(platform, 'POST', 'probe', {}, { device: adapter, localPassword: '1234' })).toEqual({ ok: true, result: ready });
    expect(platform.probe).toHaveBeenLastCalledWith(parsedAdapter, '1234');
    await handleSetupRequest(platform, 'POST', 'probe', {}, { device: adapter, localPassword: '' });
    expect(platform.probe).toHaveBeenLastCalledWith(parsedAdapter, undefined);
    expect(await handleSetupRequest(platform, 'POST', 'probe', {}, { device: { host: '' } })).toEqual({ ok: false, error: 'The device has no valid address or protocol' });
  });

  it('should register with the KEY and ask for one when it is missing', async () => {
    expect(await handleSetupRequest(platform, 'POST', 'register', {}, { device: adapter, key: '0123456789012' })).toEqual({ ok: true, result: ready });
    expect(platform.register).toHaveBeenCalledWith(parsedAdapter, '0123456789012', undefined);
    expect(await handleSetupRequest(platform, 'POST', 'register', {}, { device: adapter })).toEqual({ ok: false, error: 'Enter the KEY printed on the adapter' });
  });

  it('should store a device and refuse one that is not valid', async () => {
    const device = createDeviceConfig({ requiresLocalPassword: true, localPassword: '1234' });
    expect(await handleSetupRequest(platform, 'POST', 'device', {}, { device })).toEqual({ ok: true, state });
    expect(platform.saveDevice).toHaveBeenCalledWith(device);
    // An adapter that did not say which one it is cannot be stored from the page.
    expect(await handleSetupRequest(platform, 'POST', 'device', {}, { device: { host: '192.168.1.50', name: 'Den', protocol: 'classic' } })).toMatchObject({
      ok: false,
      error: expect.stringContaining('MAC address'),
    });
    expect(await handleSetupRequest(platform, 'POST', 'device', {}, 'text')).toMatchObject({ ok: false });
    expect(platform.saveDevice).toHaveBeenCalledTimes(1);
  });

  it('should remove a device by the MAC address of its adapter', async () => {
    expect(await handleSetupRequest(platform, 'DELETE', 'device', { macAddress: 'a408eacc91d4' })).toEqual({ ok: true });
    expect(platform.removeDevice).toHaveBeenCalledWith('A4:08:EA:CC:91:D4');
    platform.removeDevice.mockResolvedValueOnce(false);
    expect(await handleSetupRequest(platform, 'DELETE', 'device', { macAddress: 'A4:08:EA:CC:91:D5' })).toEqual({
      ok: false,
      error: 'No device has the adapter A4:08:EA:CC:91:D5',
    });
    expect(await handleSetupRequest(platform, 'DELETE', 'device', { macAddress: 'Living Room' })).toEqual({
      ok: false,
      error: 'Give the MAC address of the adapter of the device to remove',
    });
    expect(await handleSetupRequest(platform, 'DELETE', 'device')).toEqual({ ok: false, error: 'Give the MAC address of the adapter of the device to remove' });
  });

  it('should answer with the reason when a request fails', async () => {
    platform.discoverForSetup.mockRejectedValueOnce(new Error('bind EADDRINUSE 0.0.0.0:30000'));
    expect(await handleSetupRequest(platform, 'POST', 'discover')).toEqual({ ok: false, error: 'bind EADDRINUSE 0.0.0.0:30000' });
  });
});
