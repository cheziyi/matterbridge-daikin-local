/**
 * @file vitest/setup/probe.test.ts
 * @description This file contains the tests for the checks the guided setup runs against an adapter.
 * @author Calvin Che
 */

import { AirbaseDaikinClient, ClassicDaikinClient, createDaikinClient, type DaikinDevice, DaikinError, DsiotDaikinClient } from 'daikin-local-control';
import type { Mock } from 'vitest';

import { getAvailableControls } from '../../src/controls.js';
import { identifyHost, probeDevice, registerWithDevice } from '../../src/setup/probe.js';
import { createCapabilities } from '../fakeDaikin.js';

vi.mock('daikin-local-control', async (importOriginal) => ({
  ...(await importOriginal<typeof import('daikin-local-control')>()),
  createDaikinClient: vi.fn(),
}));

const createClient = vi.mocked(createDaikinClient);
const credentials = { terminalUuid: '0d120767302b4603b5ae916260815e4e' };
const classic: DaikinDevice = { host: '192.168.1.50', protocol: 'classic', name: 'Living Room' };
const dsiot: DaikinDevice = { host: '192.168.1.51', protocol: 'dsiot', name: 'Bedroom' };
const capabilities = createCapabilities();
const controls = getAvailableControls(capabilities);
const deviceInfo = { macAddress: 'A4:08:EA:CC:91:D4', firmwareVersion: '1.2.51' };
const sensors = { indoorTemperatureInC: 26.5, outdoorTemperatureInC: 31, indoorHumidityInPercent: 60 };
const basicInfo = { ret: 'OK', type: 'aircon', name: 'Living%20Room', lpw_flag: '0', en_secure: '0' };

/**
 * Build a classic client whose calls are mocks
 *
 * @returns {ClassicDaikinClient} The client, which passes `instanceof ClassicDaikinClient`.
 */
function createClassicClient(): ClassicDaikinClient & Record<'getCapabilities' | 'getSensors' | 'getDeviceInfo' | 'registerTerminal' | 'command' | 'dispose', Mock> {
  return Object.assign(Object.create(ClassicDaikinClient.prototype) as ClassicDaikinClient, {
    getCapabilities: vi.fn(async () => capabilities),
    getSensors: vi.fn(async () => sensors),
    getDeviceInfo: vi.fn(async () => deviceInfo),
    registerTerminal: vi.fn(async () => {}),
    command: vi.fn(async () => basicInfo),
    dispose: vi.fn(async () => {}),
  });
}

/**
 * Build a DSIOT client whose calls are mocks
 *
 * @returns {DsiotDaikinClient} The client, which passes `instanceof DsiotDaikinClient`.
 */
function createDsiotClient(): DsiotDaikinClient & Record<'getCapabilities' | 'getSensors' | 'getDeviceInfo' | 'dispose', Mock> {
  return Object.assign(Object.create(DsiotDaikinClient.prototype) as DsiotDaikinClient, {
    getCapabilities: vi.fn(async () => capabilities),
    getSensors: vi.fn(async () => sensors),
    getDeviceInfo: vi.fn(async () => deviceInfo),
    dispose: vi.fn(async () => {}),
  });
}

/**
 * Build an Airbase client whose calls are mocks
 *
 * @returns {AirbaseDaikinClient} The client, which passes `instanceof AirbaseDaikinClient`.
 */
function createAirbaseClient(): AirbaseDaikinClient & Record<'getDeviceInfo' | 'dispose', Mock> {
  return Object.assign(Object.create(AirbaseDaikinClient.prototype) as AirbaseDaikinClient, {
    getDeviceInfo: vi.fn(async () => deviceInfo),
    dispose: vi.fn(async () => {}),
  });
}

describe('probe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('probeDevice', () => {
    it('should report a device that answers as ready, with what its unit accepts and what its sensors read', async () => {
      const client = createClassicClient();
      client.dispose.mockRejectedValueOnce(new Error('close failed'));
      createClient.mockReturnValueOnce(client);
      // The device did not say which adapter it is, so the adapter is asked.
      expect(await probeDevice(classic, credentials)).toEqual({ status: 'ready', device: { ...classic, ...deviceInfo }, capabilities, sensors, controls });
      expect(createClient).toHaveBeenCalledWith(classic, { ...credentials, timeoutInMs: 5000 });
      expect(client.dispose).toHaveBeenCalled();
    });

    it('should take the name the adapter tells, over none and over one that was typed for it', async () => {
      const told = { ...deviceInfo, name: 'Lounge' };
      const unnamed = createClassicClient();
      unnamed.getDeviceInfo.mockResolvedValueOnce(told);
      createClient.mockReturnValueOnce(unnamed);
      expect((await probeDevice({ host: '192.168.1.50', protocol: 'classic' }, credentials)).device).toMatchObject({ name: 'Lounge', macAddress: deviceInfo.macAddress });

      const typed = createClassicClient();
      typed.getDeviceInfo.mockResolvedValueOnce(told);
      createClient.mockReturnValueOnce(typed);
      expect((await probeDevice(classic, credentials)).device.name).toBe('Lounge');

      // An adapter with an empty name, or one found by a search without a name, keeps what it had.
      const nameless = createClassicClient();
      nameless.getDeviceInfo.mockResolvedValueOnce({ name: '' });
      createClient.mockReturnValueOnce(nameless);
      const searched = { host: '192.168.1.50', protocol: 'classic', macAddress: '00:11:22:33:44:55', firmwareVersion: '1.2.51' } as const;
      expect((await probeDevice(searched, credentials)).device).toEqual({ ...searched, name: undefined });
      expect(nameless.getDeviceInfo).toHaveBeenCalledTimes(1);
    });

    it('should not ask an adapter that a search already identified which adapter it is', async () => {
      const client = createClassicClient();
      createClient.mockReturnValueOnce(client);
      const identified = { ...classic, macAddress: '00:11:22:33:44:55' };
      expect(await probeDevice(identified, credentials)).toEqual({ status: 'ready', device: identified, capabilities, sensors, controls });
      expect(client.getDeviceInfo).not.toHaveBeenCalled();
    });

    it('should ask for the child lock code before calling an adapter that requires one', async () => {
      const device = { ...classic, requiresLocalPassword: true };
      expect(await probeDevice(device, credentials)).toEqual({ status: 'localPasswordRequired', device });
      expect(createClient).not.toHaveBeenCalled();
    });

    it.each([
      ['a rejected child lock code', classic, new DaikinError('Daikin rejected the credentials (ret=LPW NG)', 401), 'localPasswordRejected'],
      ['a terminal that is not registered', classic, new DaikinError('Daikin rejected the credentials (ret=AUTH NG)', 401), 'registrationRequired'],
      ['a 403 from a classic adapter', classic, new DaikinError('Daikin request failed', 403), 'registrationRequired'],
      ['a 401 from an adapter that only takes a code', { ...classic, requiresLocalPassword: true }, new DaikinError('Daikin request failed', 401), 'localPasswordRejected'],
      [
        'a 401 from an adapter that takes both',
        { ...classic, requiresLocalPassword: true, requiresRegistration: true },
        new DaikinError('Daikin request failed', 401),
        'registrationRequired',
      ],
      ['a 401 from a DSIOT adapter', dsiot, new DaikinError('Daikin request failed', 401), 'localPasswordRejected'],
      ['a refused connection', classic, new DaikinError('refused', 503), 'unreachable'],
      ['a timeout', classic, new DaikinError('timed out', 504), 'unreachable'],
      ['an error reply', classic, new DaikinError('Daikin command failed (ret=PARAM NG)', 502), 'failed'],
      ['an unexpected error', classic, new Error('boom'), 'failed'],
    ])('should read %s', async (_case, device, error, status) => {
      const client = createClassicClient();
      client.getCapabilities.mockRejectedValueOnce(error);
      createClient.mockReturnValueOnce(client);
      const result = await probeDevice(device, { ...credentials, localPassword: '1234' });
      expect(result.status).toBe(status);
      expect(result.message).toBe(error.message);
      expect(result.device.requiresLocalPassword === true).toBe(status === 'localPasswordRejected' || device.requiresLocalPassword === true);
      expect(result.device.requiresRegistration === true).toBe(status === 'registrationRequired' || device.requiresRegistration === true);
      expect(client.dispose).toHaveBeenCalled();
    });
  });

  describe('registerWithDevice', () => {
    it('should register the terminal, then check the adapter again', async () => {
      const registering = createClassicClient();
      createClient.mockReturnValueOnce(registering).mockReturnValueOnce(createClassicClient());
      expect(await registerWithDevice(classic, '0123456789012', credentials)).toEqual({ status: 'ready', device: { ...classic, ...deviceInfo }, capabilities, sensors, controls });
      expect(registering.registerTerminal).toHaveBeenCalledWith('0123456789012');
      expect(registering.dispose).toHaveBeenCalled();
    });

    it('should report a KEY the adapter refused', async () => {
      const client = createClassicClient();
      client.registerTerminal.mockRejectedValueOnce(new DaikinError('Daikin command failed (ret=PARAM NG)', 502));
      createClient.mockReturnValueOnce(client);
      expect(await registerWithDevice(classic, 'wrong', credentials)).toMatchObject({ status: 'registrationRejected', message: 'Daikin command failed (ret=PARAM NG)' });
      expect(createClient).toHaveBeenCalledTimes(1);
    });

    it('should keep the reason when the adapter is unreachable or rejects the child lock code', async () => {
      const unreachable = createClassicClient();
      unreachable.registerTerminal.mockRejectedValueOnce(new DaikinError('timed out', 504));
      createClient.mockReturnValueOnce(unreachable);
      expect(await registerWithDevice(classic, 'key', credentials)).toMatchObject({ status: 'unreachable' });

      const locked = createClassicClient();
      locked.registerTerminal.mockRejectedValueOnce(new DaikinError('Daikin rejected the credentials (ret=LPW NG)', 401));
      createClient.mockReturnValueOnce(locked);
      expect(await registerWithDevice(classic, 'key', credentials)).toMatchObject({ status: 'localPasswordRejected' });
    });

    it('should refuse to register with an adapter that is not classic', async () => {
      const client = createDsiotClient();
      createClient.mockReturnValueOnce(client);
      expect(await registerWithDevice(dsiot, 'key', credentials)).toMatchObject({ status: 'failed', message: 'Only a classic adapter registers terminals' });
      expect(client.dispose).toHaveBeenCalled();
    });
  });

  describe('identifyHost', () => {
    it('should read the name and the requirements of a classic adapter that answers over HTTP', async () => {
      const client = createClassicClient();
      createClient.mockReturnValueOnce(client);
      expect(await identifyHost('192.168.1.50', credentials.terminalUuid)).toEqual({
        host: '192.168.1.50',
        protocol: 'classic',
        name: 'Living Room',
        requiresRegistration: false,
        usesHttps: false,
        requiresLocalPassword: false,
      });
      expect(client.command).toHaveBeenCalledWith('/common/basic_info');
      expect(createClient).toHaveBeenCalledWith(
        { host: '192.168.1.50', protocol: 'classic', usesHttps: false },
        { terminalUuid: credentials.terminalUuid, timeoutInMs: 5000, retry: { delaysInMs: [] } },
      );
    });

    it('should keep a port the user typed and use the port the adapter announces otherwise', async () => {
      const announcing = { ...basicInfo, api_port: '8080' };
      const first = createClassicClient();
      first.command.mockResolvedValueOnce(announcing);
      createClient.mockReturnValueOnce(first);
      expect((await identifyHost('192.168.1.50', credentials.terminalUuid))?.host).toBe('192.168.1.50:8080');
      const second = createClassicClient();
      second.command.mockResolvedValueOnce(announcing);
      createClient.mockReturnValueOnce(second);
      expect((await identifyHost('192.168.1.50:18081', credentials.terminalUuid))?.host).toBe('192.168.1.50:18081');
    });

    it('should take a rejection as a classic adapter that requires registration', async () => {
      const client = createClassicClient();
      client.command.mockRejectedValueOnce(new DaikinError('Daikin request failed', 403));
      createClient.mockReturnValueOnce(client);
      expect(await identifyHost('192.168.1.50', credentials.terminalUuid)).toEqual({ host: '192.168.1.50', protocol: 'classic', usesHttps: false, requiresRegistration: true });
    });

    it('should try HTTPS when nothing answers over HTTP', async () => {
      const overHttp = createClassicClient();
      overHttp.command.mockRejectedValueOnce(new DaikinError('refused', 503));
      const overHttps = createClassicClient();
      createClient.mockReturnValueOnce(overHttp).mockReturnValueOnce(overHttps);
      expect(await identifyHost('192.168.1.50', credentials.terminalUuid)).toMatchObject({ protocol: 'classic', name: 'Living Room' });
      expect(createClient).toHaveBeenLastCalledWith({ host: '192.168.1.50', protocol: 'classic', usesHttps: true }, expect.anything());
    });

    it('should find an Airbase adapter, which answers 404 to the classic question', async () => {
      const classicClient = createClassicClient();
      classicClient.command.mockRejectedValueOnce(new DaikinError('not found', 404));
      const airbaseClient = createAirbaseClient();
      createClient.mockReturnValueOnce(classicClient).mockReturnValueOnce(airbaseClient);
      expect(await identifyHost('192.168.1.52', credentials.terminalUuid)).toEqual({ host: '192.168.1.52', protocol: 'airbase', ...deviceInfo });
      expect(createClient).toHaveBeenCalledTimes(2);
      expect(createClient).toHaveBeenLastCalledWith(
        { host: '192.168.1.52', protocol: 'airbase' },
        { terminalUuid: credentials.terminalUuid, timeoutInMs: 5000, retry: { delaysInMs: [] } },
      );
      expect(airbaseClient.dispose).toHaveBeenCalled();
    });

    it('should find a DSIOT adapter, which answers neither the classic nor the Airbase question', async () => {
      const classicClient = createClassicClient();
      classicClient.command.mockRejectedValueOnce(new DaikinError('not found', 404));
      const airbaseClient = createAirbaseClient();
      airbaseClient.getDeviceInfo.mockRejectedValueOnce(new DaikinError('not found', 404));
      const dsiotClient = createDsiotClient();
      createClient.mockReturnValueOnce(classicClient).mockReturnValueOnce(airbaseClient).mockReturnValueOnce(dsiotClient);
      expect(await identifyHost('192.168.1.51', credentials.terminalUuid)).toEqual({ host: '192.168.1.51', protocol: 'dsiot', ...deviceInfo });
      expect(createClient).toHaveBeenCalledTimes(3);
      expect(airbaseClient.dispose).toHaveBeenCalled();
      expect(dsiotClient.dispose).toHaveBeenCalled();
    });

    it('should find a DSIOT adapter that asks for its child lock code', async () => {
      const classicClient = createClassicClient();
      classicClient.command.mockRejectedValueOnce('odd');
      const dsiotClient = createDsiotClient();
      dsiotClient.getDeviceInfo.mockRejectedValueOnce(new DaikinError('Daikin rejected the credentials', 401));
      createClient.mockReturnValueOnce(classicClient).mockReturnValueOnce(dsiotClient);
      expect(await identifyHost('192.168.1.51', credentials.terminalUuid)).toEqual({ host: '192.168.1.51', protocol: 'dsiot', requiresLocalPassword: true });
    });

    it('should find nothing where no adapter answers', async () => {
      const overHttp = createClassicClient();
      overHttp.command.mockRejectedValueOnce(new DaikinError('timed out', 504));
      const overHttps = createClassicClient();
      overHttps.command.mockRejectedValueOnce(new DaikinError('timed out', 504));
      const dsiotClient = createDsiotClient();
      dsiotClient.getDeviceInfo.mockRejectedValueOnce(new DaikinError('timed out', 504));
      createClient.mockReturnValueOnce(overHttp).mockReturnValueOnce(overHttps).mockReturnValueOnce(dsiotClient);
      expect(await identifyHost('192.168.1.99', credentials.terminalUuid)).toBeUndefined();
      expect(createClient).toHaveBeenCalledTimes(3);
    });

    it('should not take a client of another kind for a classic adapter', async () => {
      const other = createDsiotClient();
      other.getDeviceInfo.mockRejectedValueOnce(new Error('not a DSIOT adapter'));
      createClient.mockReturnValueOnce(createDsiotClient()).mockReturnValueOnce(other);
      expect(await identifyHost('192.168.1.99', credentials.terminalUuid)).toBeUndefined();
      expect(createClient).toHaveBeenCalledTimes(2);
    });
  });
});
