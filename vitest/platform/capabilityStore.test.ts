/**
 * @file vitest/platform/capabilityStore.test.ts
 * @description This file contains the tests for the store of what each unit accepts.
 * @author Calvin Che
 */

/* oxlint-disable unicorn/no-useless-undefined */

import type { NodeStorage } from 'node-persist-manager';

import { CapabilityStore } from '../../src/platform/capabilityStore.js';
import { createCapabilities, createDeviceConfig, macOf } from '../fakeDaikin.js';

const entries = new Map<string, unknown>();
const storage = {
  get: async (key: string) => entries.get(key),
  set: async (key: string, value: unknown) => {
    entries.set(key, value);
  },
  remove: async (key: string) => {
    entries.delete(key);
  },
} as unknown as NodeStorage;

describe('capabilityStore', () => {
  const device = createDeviceConfig();
  const key = `capabilities:${macOf('Living Room')}`;

  beforeEach(() => {
    entries.clear();
  });

  test('should keep what a unit accepts under the MAC address of its adapter', async () => {
    const store = new CapabilityStore(() => storage);
    expect(await store.read(device)).toBeUndefined();
    await store.write(device, createCapabilities());
    expect(entries.get(key)).toEqual(createCapabilities());
    // A new name and a new address are the same unit.
    const renamed = { ...device, name: 'Lounge', host: '192.168.1.99' };
    expect(await store.read(renamed)).toEqual(createCapabilities());
    await store.remove(device);
    expect(await store.read(device)).toBeUndefined();
  });

  test('should not read a stored value that is not the capabilities of a unit', async () => {
    const store = new CapabilityStore(() => storage);
    entries.set(key, 'capabilities');
    expect(await store.read(device)).toBeUndefined();
    entries.set(key, { ...createCapabilities(), fanSpeeds: undefined });
    expect(await store.read(device)).toBeUndefined();
    entries.set(key, { ...createCapabilities(), specialModes: undefined });
    expect(await store.read(device)).toBeUndefined();
  });

  test('should keep which readings a unit has given, and forget them with what it accepts', async () => {
    const store = new CapabilityStore(() => storage);
    const sensors = { hasHumidity: true, hasOutdoorTemperature: false };
    expect(await store.readSensors(device)).toBeUndefined();
    await store.writeSensors(device, sensors);
    expect(entries.get(`sensors:${macOf('Living Room')}`)).toEqual(sensors);
    const renamed = { ...device, name: 'Lounge' };
    expect(await store.readSensors(renamed)).toEqual(sensors);
    entries.set(`sensors:${macOf('Living Room')}`, { hasHumidity: true });
    expect(await store.readSensors(device)).toBeUndefined();
    entries.set(`sensors:${macOf('Living Room')}`, 'sensors');
    expect(await store.readSensors(device)).toBeUndefined();
    await store.remove(device);
    expect(entries.size).toBe(0);
  });

  test('should store and read nothing until the platform storage is there', async () => {
    const store = new CapabilityStore(() => undefined);
    await store.write(device, createCapabilities());
    await store.writeSensors(device, { hasHumidity: true, hasOutdoorTemperature: true });
    await store.remove(device);
    expect(await store.read(device)).toBeUndefined();
    expect(await store.readSensors(device)).toBeUndefined();
    expect(entries.size).toBe(0);
  });
});
