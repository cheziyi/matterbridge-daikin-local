/**
 * @file vitest/mapping.test.ts
 * @description This file contains the tests for the conversions between the Daikin model and the Matter clusters.
 * @author Calvin Che
 */

import { FanControl, Thermostat } from 'matterbridge/matter/clusters';

import {
  clampTemperature,
  composeDeviceName,
  fanStepToPercent,
  getFanModeSequence,
  getFanSteps,
  getSwingAxes,
  getTemperatureRange,
  getThermostatProfile,
  percentToFanStep,
  resolveSwingMode,
  toMatterTemperature,
  toOperatingMode,
  toSystemMode,
} from '../src/mapping.js';
import { createCapabilities } from './fakeDaikin.js';

describe('mapping', () => {
  test('should list the fan steps slowest first, without auto', () => {
    expect(getFanSteps(['level5', 'auto', 'silent', 'level1'])).toEqual(['silent', 'level1', 'level5']);
    expect(getFanSteps(['auto'])).toEqual([]);
  });

  test('should convert every fan step to a percent that converts back to the same step', () => {
    for (let stepCount = 1; stepCount <= 6; stepCount++) {
      for (let step = 1; step <= stepCount; step++) {
        const percent = fanStepToPercent(stepCount, step);
        expect(percent).toBeGreaterThanOrEqual(1);
        expect(percent).toBeLessThanOrEqual(100);
        expect(percentToFanStep(stepCount, percent)).toBe(step);
      }
    }
    expect(fanStepToPercent(6, 6)).toBe(100);
    expect(fanStepToPercent(6, 1)).toBe(16);
  });

  test('should convert any percent to a step of the unit', () => {
    expect(percentToFanStep(6, 0)).toBe(1);
    expect(percentToFanStep(6, 1)).toBe(1);
    // The nearest step, the faster one halfway: 17 % is nearest the first sixth, and 25 % halfway to the second.
    expect(percentToFanStep(6, 17)).toBe(1);
    expect(percentToFanStep(6, 24)).toBe(1);
    expect(percentToFanStep(6, 25)).toBe(2);
    expect(percentToFanStep(6, 100)).toBe(6);
    expect(percentToFanStep(6, 250)).toBe(6);
  });

  test('should pick the fan mode sequence from the number of steps and auto', () => {
    expect(getFanModeSequence(6, true)).toBe(FanControl.FanModeSequence.OffLowMedHighAuto);
    expect(getFanModeSequence(3, false)).toBe(FanControl.FanModeSequence.OffLowMedHigh);
    expect(getFanModeSequence(2, true)).toBe(FanControl.FanModeSequence.OffLowHighAuto);
    expect(getFanModeSequence(2, false)).toBe(FanControl.FanModeSequence.OffLowHigh);
    expect(getFanModeSequence(1, true)).toBe(FanControl.FanModeSequence.OffHighAuto);
    expect(getFanModeSequence(1, false)).toBe(FanControl.FanModeSequence.OffHigh);
  });

  test('should pick the thermostat profile from the modes of the unit', () => {
    expect(getThermostatProfile(['auto', 'cool', 'heat'])).toBe('heatCool');
    expect(getThermostatProfile(['cool', 'fan'])).toBe('cool');
    expect(getThermostatProfile(['heat'])).toBe('heat');
    expect(getThermostatProfile(['fan', 'dehumidify'])).toBeUndefined();
  });

  test('should convert the Daikin modes to Matter system modes', () => {
    expect(toSystemMode('cool', 'heatCool')).toBe(Thermostat.SystemMode.Cool);
    expect(toSystemMode('heat', 'heatCool')).toBe(Thermostat.SystemMode.Heat);
    expect(toSystemMode('dehumidify', 'cool')).toBe(Thermostat.SystemMode.Dry);
    expect(toSystemMode('fan', 'cool')).toBe(Thermostat.SystemMode.FanOnly);
    expect(toSystemMode('auto', 'heatCool')).toBe(Thermostat.SystemMode.Auto);
    expect(toSystemMode('auto', 'cool')).toBe(Thermostat.SystemMode.Cool);
    expect(toSystemMode('auto', 'heat')).toBe(Thermostat.SystemMode.Heat);
    // A mode with a replacement shows as it, and the others stay as they are.
    const replacements = { dehumidify: 'heat', fan: 'auto', heat: 'dehumidify' } as const;
    expect(toSystemMode('dehumidify', 'heatCool', replacements)).toBe(Thermostat.SystemMode.Heat);
    expect(toSystemMode('fan', 'heatCool', replacements)).toBe(Thermostat.SystemMode.Auto);
    expect(toSystemMode('heat', 'heat', replacements)).toBe(Thermostat.SystemMode.Dry);
    expect(toSystemMode('cool', 'heatCool', replacements)).toBe(Thermostat.SystemMode.Cool);
  });

  test('should convert Matter system modes to the Daikin modes the unit offers', () => {
    const modes = ['auto', 'dehumidify', 'cool', 'heat', 'fan'] as const;
    expect(toOperatingMode(Thermostat.SystemMode.Auto, modes)).toBe('auto');
    expect(toOperatingMode(Thermostat.SystemMode.Cool, modes)).toBe('cool');
    expect(toOperatingMode(Thermostat.SystemMode.Precooling, modes)).toBe('cool');
    expect(toOperatingMode(Thermostat.SystemMode.Heat, modes)).toBe('heat');
    expect(toOperatingMode(Thermostat.SystemMode.EmergencyHeat, modes)).toBe('heat');
    expect(toOperatingMode(Thermostat.SystemMode.FanOnly, modes)).toBe('fan');
    expect(toOperatingMode(Thermostat.SystemMode.Dry, modes)).toBe('dehumidify');
    expect(toOperatingMode(Thermostat.SystemMode.Sleep, modes)).toBeUndefined();
    expect(toOperatingMode(Thermostat.SystemMode.Heat, ['cool'])).toBeUndefined();
    // The system mode of a replacement is that of the mode of the unit shown as it.
    const coolOnly = ['cool', 'dehumidify', 'fan'] as const;
    const replacements = { dehumidify: 'heat', fan: 'auto' } as const;
    expect(toOperatingMode(Thermostat.SystemMode.Heat, coolOnly, replacements)).toBe('dehumidify');
    expect(toOperatingMode(Thermostat.SystemMode.EmergencyHeat, coolOnly, replacements)).toBe('dehumidify');
    expect(toOperatingMode(Thermostat.SystemMode.Auto, coolOnly, replacements)).toBe('fan');
    expect(toOperatingMode(Thermostat.SystemMode.Cool, coolOnly, replacements)).toBe('cool');
    expect(toOperatingMode(Thermostat.SystemMode.Sleep, coolOnly, replacements)).toBeUndefined();
  });

  test('should clamp a setpoint to the range and round it to the step', () => {
    const range = { min: 18, max: 32, step: 0.5 };
    expect(clampTemperature(24.2, range)).toBe(24);
    expect(clampTemperature(24.3, range)).toBe(24.5);
    expect(clampTemperature(10, range)).toBe(18);
    expect(clampTemperature(40, range)).toBe(32);
    expect(clampTemperature(Number.NaN, range)).toBe(18);
    expect(clampTemperature(24.4, { min: 18, max: 32, step: 0 })).toBe(24);
    expect(clampTemperature(31.9, { min: 18, max: 31.5, step: 2 })).toBe(31.5);
  });

  test('should encode a temperature as Matter does', () => {
    expect(toMatterTemperature(26.5)).toBe(2650);
    expect(toMatterTemperature(21.999)).toBe(2200);
  });

  test('should fall back to 16 to 32 °C for a mode without a range', () => {
    const capabilities = createCapabilities();
    expect(getTemperatureRange(capabilities, 'cool')).toEqual({ min: 18, max: 32, step: 0.5 });
    expect(getTemperatureRange(capabilities, 'fan')).toEqual({ min: 16, max: 32, step: 1 });
  });

  test('should split a swing mode into its axes', () => {
    expect(getSwingAxes('off')).toEqual({ vertical: false, horizontal: false });
    expect(getSwingAxes('vertical')).toEqual({ vertical: true, horizontal: false });
    expect(getSwingAxes('horizontal')).toEqual({ vertical: false, horizontal: true });
    expect(getSwingAxes('both')).toEqual({ vertical: true, horizontal: true });
  });

  test('should work out the swing mode after a switch changes', () => {
    const all = ['off', 'vertical', 'horizontal', 'both'] as const;
    expect(resolveSwingMode('off', { vertical: true }, all)).toBe('vertical');
    expect(resolveSwingMode('vertical', { horizontal: true }, all)).toBe('both');
    expect(resolveSwingMode('both', { vertical: false }, all)).toBe('horizontal');
    expect(resolveSwingMode('both', { vertical: false, horizontal: false }, all)).toBe('off');
    expect(resolveSwingMode('horizontal', {}, all)).toBe('horizontal');
  });

  test('should swing on the axis just turned on when the unit cannot swing on both', () => {
    const single = ['off', 'vertical', 'horizontal'] as const;
    expect(resolveSwingMode('vertical', { horizontal: true }, single)).toBe('horizontal');
    expect(resolveSwingMode('horizontal', { vertical: true }, single)).toBe('vertical');
    expect(resolveSwingMode('off', { horizontal: true }, ['off', 'vertical'])).toBe('off');
    expect(resolveSwingMode('vertical', { vertical: true, horizontal: true }, ['off', 'horizontal'])).toBe('horizontal');
    expect(resolveSwingMode('vertical', { vertical: false }, ['vertical', 'both'])).toBe('vertical');
    expect(resolveSwingMode('off', { vertical: true, horizontal: true }, ['off', 'vertical'])).toBe('off');
  });

  test('should keep the name of an extra endpoint within 32 characters by cutting the base name', () => {
    expect(composeDeviceName('Living Room', 'Vertical Swing')).toBe('Living Room Vertical Swing');
    const long = composeDeviceName('The Very Large Upstairs Living Room', 'Horizontal Swing');
    expect(long).toBe('The Very Large Horizontal Swing');
    expect(long.length).toBeLessThanOrEqual(32);
  });
});
