/**
 * @file vitest/fakeDaikin.ts
 * @description This file contains the fake Daikin unit and fixtures shared by the tests.
 * @author Calvin Che
 */

/* oxlint-disable typescript/require-await */
/* oxlint-disable typescript/no-unsafe-type-assertion */

import { createHash } from 'node:crypto';

import type { DaikinCapabilities, DaikinClient, DaikinControl, DaikinDeviceInfo, DaikinSensors, DaikinState, DaikinStateAndSensors, SpecialMode } from 'daikin-local-control';
import type { Mock } from 'vitest';

import type { DaikinDeviceConfig } from '../src/config.js';

export interface FakeClient extends DaikinClient {
  state: DaikinState;
  sensors: DaikinSensors;
  getDeviceInfo: Mock<() => Promise<DaikinDeviceInfo>>;
  getCapabilities: Mock<() => Promise<DaikinCapabilities>>;
  getState: Mock<() => Promise<DaikinState>>;
  setState: Mock<(control: DaikinControl) => Promise<void>>;
  getSensors: Mock<() => Promise<DaikinSensors>>;
  getStateAndSensors: Mock<() => Promise<DaikinStateAndSensors>>;
  setSpecialMode: Mock<(specialMode: SpecialMode, isOn: boolean) => Promise<void>>;
  dispose: Mock<() => Promise<void>>;
}

/**
 * Build the capabilities of a unit that heats, cools and swings on both axes
 *
 * @param {Partial<DaikinCapabilities>} overrides The fields to replace.
 * @returns {DaikinCapabilities} The capabilities.
 */
export function createCapabilities(overrides: Partial<DaikinCapabilities> = {}): DaikinCapabilities {
  return {
    modes: ['auto', 'dehumidify', 'cool', 'heat', 'fan'],
    fanSpeeds: ['auto', 'silent', 'level1', 'level2', 'level3', 'level4', 'level5'],
    swingModes: ['off', 'vertical', 'horizontal', 'both'],
    verticalPositions: [],
    horizontalPositions: [],
    targetTemperaturesInC: {
      auto: { min: 18, max: 30, step: 0.5 },
      dehumidify: null,
      cool: { min: 18, max: 32, step: 0.5 },
      heat: { min: 10, max: 30, step: 0.5 },
      fan: null,
    },
    targetHumidities: { auto: [], dehumidify: [], cool: [], heat: [], fan: [] },
    specialModes: { auto: [], dehumidify: [], cool: [], heat: [], fan: [] },
    specialOutlet: false,
    energyMonitoring: false,
    demandControl: false,
    scheduleTimer: false,
    ...overrides,
  };
}

/**
 * Make up the MAC address of the adapter of a unit, the same one each time for the same name
 *
 * @param {string} name The name the unit has when it is first set up.
 * @returns {string} A MAC address, such as `A4:08:EA:1B:3F:07`.
 */
export function macOf(name: string): string {
  const digits = createHash('sha256').update(name).digest('hex').slice(0, 6).toUpperCase();
  return `A4:08:EA:${digits.slice(0, 2)}:${digits.slice(2, 4)}:${digits.slice(4, 6)}`;
}

/**
 * Build a stored device
 *
 * @param {Partial<DaikinDeviceConfig>} overrides The fields to replace.
 * @returns {DaikinDeviceConfig} The device.
 */
export function createDeviceConfig(overrides: Partial<DaikinDeviceConfig> = {}): DaikinDeviceConfig {
  return {
    name: 'Living Room',
    macAddress: macOf(overrides.name ?? 'Living Room'),
    host: '192.168.1.50',
    protocol: 'classic',
    requiresRegistration: false,
    usesHttps: false,
    requiresLocalPassword: false,
    fanControl: 'steps',
    fanSpeedWhenHidden: 'keep',
    swingControl: 'switches',
    swingAxes: 'both',
    swingModeWhenHidden: 'keep',
    modeControl: 'native',
    modeSwitches: [],
    modeReplacements: {},
    fanAutoControl: 'native',
    hasSeparateFan: false,
    specialModeSwitches: [],
    hasOutdoorTemperatureSensor: true,
    hasSeparateHumiditySensor: false,
    isComposed: false,
    ...overrides,
  };
}

/**
 * Build a client that holds its state in memory, as a unit does
 *
 * @param {Partial<DaikinState>} state The fields of the state to replace.
 * @param {DaikinCapabilities} capabilities What the unit accepts.
 * @returns {FakeClient} The client, with every method a mock.
 */
export function createFakeClient(state: Partial<DaikinState> = {}, capabilities: DaikinCapabilities = createCapabilities()): FakeClient {
  const client = {} as FakeClient;
  const methods: FakeClient = {
    state: {
      power: true,
      mode: 'cool',
      targetTemperatureInC: 24,
      targetHumidity: null,
      fanSpeed: 'level3',
      swingMode: 'vertical',
      verticalPosition: null,
      horizontalPosition: null,
      specialModes: [],
      ...state,
    },
    // A unit that gives its room temperature alone: a test sets the other readings to have them in Matter.
    sensors: { indoorTemperatureInC: 26.5, outdoorTemperatureInC: null, indoorHumidityInPercent: null },
    getDeviceInfo: vi.fn(async () => ({})),
    getCapabilities: vi.fn(async () => capabilities),
    getState: vi.fn(async () => ({ ...client.state, specialModes: [...client.state.specialModes] })),
    setState: vi.fn(async (control: DaikinControl) => {
      Object.assign(client.state, control);
    }),
    getSensors: vi.fn(async () => ({ ...client.sensors })),
    // One read for each, so a test can fail either of them.
    getStateAndSensors: vi.fn(async () => ({ state: await client.getState(), sensors: await client.getSensors() })),
    setSpecialMode: vi.fn(async (specialMode: SpecialMode, isOn: boolean) => {
      client.state.specialModes = client.state.specialModes.filter((mode) => mode !== specialMode);
      if (isOn) client.state.specialModes.push(specialMode);
    }),
    dispose: vi.fn(async () => Promise.resolve()),
    // `await using` disposes the client the way a caller would, so the mock records it.
    [Symbol.asyncDispose]: async () => client.dispose(),
  };
  Object.assign(client, methods);
  return client;
}
