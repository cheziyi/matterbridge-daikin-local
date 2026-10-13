/**
 * @file vitest/controls.test.ts
 * @description This file contains the tests for what the capabilities of a unit let its device have in Matter.
 * @author Calvin Che
 */

import { addReportedSensors, fitToCapabilities, getAvailableControls, getSwitchableSpecialModes, hasFanAuto, hasSameControls, noReportedSensors } from '../src/controls.js';
import { createCapabilities, createDeviceConfig } from './fakeDaikin.js';

describe('controls', () => {
  it('should replace a fixed setting the unit does not take by keep', () => {
    const unit = createCapabilities({ modes: ['cool', 'fan'], fanSpeeds: ['auto', 'level1', 'level3'], swingModes: ['off', 'vertical'] });
    const fitting = createDeviceConfig({ fanControl: 'hidden', fanSpeedWhenHidden: 'level3', swingControl: 'hidden', swingModeWhenHidden: 'vertical' });
    expect(fitToCapabilities(fitting, unit)).toEqual(fitting);
    expect(fitToCapabilities(createDeviceConfig(), unit)).toEqual(createDeviceConfig());
    expect(fitToCapabilities(createDeviceConfig({ fanSpeedWhenHidden: 'level5', swingModeWhenHidden: 'both' }), unit)).toEqual(createDeviceConfig());
    // The unit has a fan mode and no dry mode.
    expect(fitToCapabilities(createDeviceConfig({ hasDryModeSwitch: true, hasFanModeSwitch: true }), unit)).toEqual(createDeviceConfig({ hasFanModeSwitch: true }));
  });

  it('should keep the switch for the auto fan speed only where it can hold', () => {
    const unit = createCapabilities();
    expect(hasFanAuto(unit)).toBe(true);
    expect(hasFanAuto({ fanSpeeds: ['auto'] })).toBe(false);
    expect(hasFanAuto({ fanSpeeds: ['level1', 'level2'] })).toBe(false);
    const wanted = createDeviceConfig({ hasFanAutoSwitch: true });
    expect(fitToCapabilities(wanted, unit).hasFanAutoSwitch).toBe(true);
    expect(fitToCapabilities({ ...wanted, fanControl: 'hidden' }, unit).hasFanAutoSwitch).toBe(true);
    // A fixed fan speed is sent with every command, so auto would not last.
    expect(fitToCapabilities({ ...wanted, fanControl: 'hidden', fanSpeedWhenHidden: 'level1' }, unit).hasFanAutoSwitch).toBe(false);
    expect(fitToCapabilities(wanted, createCapabilities({ fanSpeeds: ['level1', 'level2'] })).hasFanAutoSwitch).toBe(false);
  });

  it('should keep a fan of its own for a device that shows a fan speed', () => {
    const wanted = createDeviceConfig({ hasSeparateFan: true });
    expect(fitToCapabilities(wanted, createCapabilities()).hasSeparateFan).toBe(true);
    expect(fitToCapabilities({ ...wanted, fanControl: 'percent' }, createCapabilities()).hasSeparateFan).toBe(true);
    expect(fitToCapabilities({ ...wanted, fanControl: 'hidden' }, createCapabilities()).hasSeparateFan).toBe(false);
    // The unit takes no fan speed but auto, so it has no fan control to show.
    expect(fitToCapabilities(wanted, createCapabilities({ fanSpeeds: ['auto'] })).hasSeparateFan).toBe(false);
  });

  it('should keep the switches of the special modes a unit takes', () => {
    const specialModes = { auto: [], dehumidify: [], cool: ['powerful', 'econo'], heat: ['powerful'], fan: [] } as const;
    const unit = createCapabilities({ specialModes });
    expect(getSwitchableSpecialModes(unit)).toEqual(['powerful', 'econo']);
    const wanted = createDeviceConfig({ specialModeSwitches: ['powerful', 'streamer'] });
    expect(fitToCapabilities(wanted, unit).specialModeSwitches).toEqual(['powerful']);
    // A DSIOT adapter turns special modes on and off as a classic one does.
    expect(fitToCapabilities({ ...wanted, protocol: 'dsiot' }, unit).specialModeSwitches).toEqual(['powerful']);
  });

  it('should compare two readings of a unit by what its endpoints are built from', () => {
    const reading = createCapabilities();
    expect(hasSameControls(reading, createCapabilities({ model: '0ABB', energyMonitoring: true }))).toBe(true);
    expect(hasSameControls(reading, createCapabilities({ modes: ['cool'] }))).toBe(false);
    expect(hasSameControls(reading, createCapabilities({ fanSpeeds: ['auto', 'level1'] }))).toBe(false);
    expect(hasSameControls(reading, createCapabilities({ swingModes: ['off', 'vertical'] }))).toBe(false);
    expect(hasSameControls(reading, createCapabilities({ specialModes: { ...reading.specialModes, cool: ['powerful'] } }))).toBe(false);
    const whole = { ...reading.targetTemperaturesInC, cool: { min: 18, max: 32, step: 1 } };
    expect(hasSameControls(reading, createCapabilities({ targetTemperaturesInC: whole }))).toBe(false);
    // The same ranges listed in another order are the same ranges.
    const { auto, ...rest } = reading.targetTemperaturesInC;
    expect(hasSameControls(reading, createCapabilities({ targetTemperaturesInC: { ...rest, auto } }))).toBe(true);
  });

  it('should list the controls and the switches a device can have', () => {
    const specialModes = { ...createCapabilities().specialModes, cool: ['powerful', 'econo'], heat: ['streamer'] } as const;
    expect(getAvailableControls(createCapabilities({ specialModes }))).toEqual({
      fanSteps: ['silent', 'level1', 'level2', 'level3', 'level4', 'level5'],
      hasFanAuto: true,
      hasSwing: true,
      hasDryMode: true,
      hasFanMode: true,
      specialModes: ['powerful', 'econo', 'streamer'],
    });
    expect(getAvailableControls(createCapabilities({ modes: ['heat'], fanSpeeds: ['auto'], swingModes: [] }))).toEqual({
      fanSteps: [],
      hasFanAuto: false,
      hasSwing: false,
      hasDryMode: false,
      hasFanMode: false,
      specialModes: [],
    });
  });

  it('should count a reading from the first time a unit gives it, and keep counting it', () => {
    const nothing = { indoorTemperatureInC: 26, outdoorTemperatureInC: null, indoorHumidityInPercent: null };
    // The same object comes back when the unit gave nothing new.
    expect(addReportedSensors(noReportedSensors, nothing)).toBe(noReportedSensors);
    const humid = addReportedSensors(noReportedSensors, { ...nothing, indoorHumidityInPercent: 55 });
    expect(humid).toEqual({ hasHumidity: true, hasOutdoorTemperature: false });
    expect(addReportedSensors(humid, nothing)).toBe(humid);
    expect(addReportedSensors(humid, { ...nothing, outdoorTemperatureInC: 0 })).toEqual({ hasHumidity: true, hasOutdoorTemperature: true });
  });
});
