/**
 * @file vitest/controls.test.ts
 * @description This file contains the tests for what the capabilities of a unit let its device have in Matter.
 * @author Calvin Che
 */

import {
  addReportedSensors,
  fitToCapabilities,
  getAvailableControls,
  getModeReplacements,
  getSwingModes,
  getSwitchableSpecialModes,
  hasFanAuto,
  hasSameControls,
  noReportedSensors,
} from '../src/controls.js';
import { createCapabilities, createDeviceConfig } from './fakeDaikin.js';

describe('controls', () => {
  test('should replace a fixed setting the unit does not take by keep', () => {
    const unit = createCapabilities({ modes: ['cool', 'fan'], fanSpeeds: ['auto', 'level1', 'level3'], swingModes: ['off', 'vertical'] });
    const fitting = createDeviceConfig({ fanControl: 'hidden', fanSpeedWhenHidden: 'level3', swingControl: 'hidden', swingModeWhenHidden: 'vertical' });
    expect(fitToCapabilities(fitting, unit)).toEqual(fitting);
    expect(fitToCapabilities(createDeviceConfig(), unit)).toEqual(createDeviceConfig());
    expect(fitToCapabilities(createDeviceConfig({ fanSpeedWhenHidden: 'level5', swingModeWhenHidden: 'both' }), unit)).toEqual(createDeviceConfig());
    // The unit has a fan mode and no dry mode.
    const switches = createDeviceConfig({ modeControl: 'switches', modeSwitches: ['dehumidify', 'fan'] });
    expect(fitToCapabilities(switches, unit)).toEqual(createDeviceConfig({ modeControl: 'switches', modeSwitches: ['fan'] }));
    // With none of the switches left, the thermostat alone remains.
    expect(fitToCapabilities({ ...switches, modeSwitches: ['dehumidify'] }, unit)).toEqual(createDeviceConfig());
  });

  test('should keep one rocking axis alone only on a unit that swings on both', () => {
    const wanted = createDeviceConfig({ swingControl: 'native', swingAxes: 'horizontal' });
    expect(fitToCapabilities(wanted, createCapabilities())).toEqual(wanted);
    expect(fitToCapabilities(wanted, createCapabilities({ swingModes: ['off', 'both'] }))).toEqual(wanted);
    expect(fitToCapabilities(wanted, createCapabilities({ swingModes: ['off', 'vertical'] }))).toEqual(createDeviceConfig({ swingControl: 'native' }));
    expect(getAvailableControls(createCapabilities({ swingModes: ['off', 'both'] })).swingsOnBothAxes).toBe(true);
    expect(getAvailableControls(createCapabilities({ swingModes: ['off', 'horizontal'] })).swingsOnBothAxes).toBe(false);
  });

  test('should keep the mode select of a unit with a dry or a fan mode', () => {
    const wanted = createDeviceConfig({ modeControl: 'select' });
    expect(fitToCapabilities(wanted, createCapabilities({ modes: ['cool', 'dehumidify'] })).modeControl).toBe('select');
    expect(fitToCapabilities(wanted, createCapabilities({ modes: ['cool', 'fan'] })).modeControl).toBe('select');
    // The thermostat mode offers every other mode.
    expect(fitToCapabilities(wanted, createCapabilities({ modes: ['auto', 'cool', 'heat'] })).modeControl).toBe('native');
  });

  test('should keep a switch for any mode the unit has', () => {
    const wanted = createDeviceConfig({ modeControl: 'switches', modeSwitches: ['auto', 'cool', 'heat'] });
    expect(fitToCapabilities(wanted, createCapabilities({ modes: ['cool', 'heat'] })).modeSwitches).toEqual(['cool', 'heat']);
  });

  test('should keep the mode replacements the unit can take, beside any mode control', () => {
    const wanted = createDeviceConfig({ modeReplacements: { dehumidify: 'heat', fan: 'auto' } });
    // Heat gives a unit that only cools the heating, which Auto needs.
    expect(fitToCapabilities(wanted, createCapabilities({ modes: ['cool', 'dehumidify', 'fan'] }))).toEqual(wanted);
    // Without it, Matter has no Auto on a unit that only cools.
    expect(fitToCapabilities(wanted, createCapabilities({ modes: ['cool', 'fan'] }))).toEqual(createDeviceConfig());
    // A mode the unit has itself is never taken: the unit would lose it.
    expect(fitToCapabilities(wanted, createCapabilities())).toEqual(createDeviceConfig());
    expect(fitToCapabilities(wanted, createCapabilities({ modes: ['auto', 'cool', 'dehumidify', 'fan'] })).modeReplacements).toEqual({ dehumidify: 'heat' });
    // Any mode of the unit can be shown as any mode it lacks.
    expect(fitToCapabilities({ ...wanted, modeReplacements: { auto: 'heat' } }, createCapabilities({ modes: ['auto', 'cool'] })).modeReplacements).toEqual({ auto: 'heat' });
    expect(fitToCapabilities({ ...wanted, modeReplacements: { heat: 'dehumidify' } }, createCapabilities({ modes: ['heat'] })).modeReplacements).toEqual({ heat: 'dehumidify' });
    const withSwitches = createDeviceConfig({ ...wanted, modeControl: 'switches', modeSwitches: ['fan'] });
    expect(fitToCapabilities(withSwitches, createCapabilities({ modes: ['cool', 'dehumidify', 'fan'] }))).toEqual(withSwitches);
  });

  test('should keep the mode switches only while switches are chosen', () => {
    const select = createDeviceConfig({ modeControl: 'select', modeSwitches: ['dehumidify', 'fan'] });
    expect(fitToCapabilities(select, createCapabilities())).toEqual(createDeviceConfig({ modeControl: 'select' }));
    // Without a dry or a fan mode there is no mode select, and nothing for the switches either.
    expect(fitToCapabilities(select, createCapabilities({ modes: ['auto', 'cool', 'heat'] }))).toEqual(createDeviceConfig());
  });

  test('should keep the switch for the auto fan speed only where it can hold', () => {
    const unit = createCapabilities();
    expect(hasFanAuto(unit)).toBe(true);
    expect(hasFanAuto({ fanSpeeds: ['auto'] })).toBe(false);
    expect(hasFanAuto({ fanSpeeds: ['level1', 'level2'] })).toBe(false);
    const wanted = createDeviceConfig({ fanAutoControl: 'switch' });
    expect(fitToCapabilities(wanted, unit).fanAutoControl).toBe('switch');
    expect(fitToCapabilities({ ...wanted, fanControl: 'hidden' }, unit).fanAutoControl).toBe('switch');
    // A fixed fan speed is sent with every command, so auto would not last.
    expect(fitToCapabilities({ ...wanted, fanControl: 'hidden', fanSpeedWhenHidden: 'level1' }, unit).fanAutoControl).toBe('native');
    expect(fitToCapabilities(wanted, createCapabilities({ fanSpeeds: ['level1', 'level2'] })).fanAutoControl).toBe('native');
  });

  test('should keep the auto fan step only on a fan control that is shown', () => {
    const unit = createCapabilities();
    const wanted = createDeviceConfig({ fanAutoControl: 'firstStep' });
    expect(fitToCapabilities(wanted, unit).fanAutoControl).toBe('firstStep');
    expect(fitToCapabilities({ ...wanted, fanAutoControl: 'lastStep', fanControl: 'percent' }, unit).fanAutoControl).toBe('lastStep');
    expect(fitToCapabilities({ ...wanted, fanControl: 'hidden' }, unit).fanAutoControl).toBe('native');
    expect(fitToCapabilities(wanted, createCapabilities({ fanSpeeds: ['level1', 'level2'] })).fanAutoControl).toBe('native');
  });

  test('should keep a fan of its own for a device that shows a fan speed', () => {
    const wanted = createDeviceConfig({ hasSeparateFan: true });
    expect(fitToCapabilities(wanted, createCapabilities()).hasSeparateFan).toBe(true);
    expect(fitToCapabilities({ ...wanted, fanControl: 'percent' }, createCapabilities()).hasSeparateFan).toBe(true);
    expect(fitToCapabilities({ ...wanted, fanControl: 'hidden' }, createCapabilities()).hasSeparateFan).toBe(false);
    // The unit takes no fan speed but auto, so it has no fan control to show.
    expect(fitToCapabilities(wanted, createCapabilities({ fanSpeeds: ['auto'] })).hasSeparateFan).toBe(false);
  });

  test('should keep the switches of the special modes a unit takes', () => {
    const specialModes = { auto: [], dehumidify: [], cool: ['powerful', 'econo'], heat: ['powerful'], fan: [] } as const;
    const unit = createCapabilities({ specialModes });
    expect(getSwitchableSpecialModes(unit)).toEqual(['powerful', 'econo']);
    const wanted = createDeviceConfig({ specialModeSwitches: ['powerful', 'streamer'] });
    expect(fitToCapabilities(wanted, unit).specialModeSwitches).toEqual(['powerful']);
    // A DSIOT adapter turns special modes on and off as a classic one does.
    expect(fitToCapabilities({ ...wanted, protocol: 'dsiot' }, unit).specialModeSwitches).toEqual(['powerful']);
  });

  test('should compare two readings of a unit by what its endpoints are built from', () => {
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

  test('should list the controls and the switches a device can have', () => {
    const specialModes = { ...createCapabilities().specialModes, cool: ['powerful', 'econo'], heat: ['streamer', 'heatPlus'] } as const;
    expect(getAvailableControls(createCapabilities({ specialModes }))).toEqual({
      fanSteps: ['silent', 'level1', 'level2', 'level3', 'level4', 'level5'],
      hasFanAuto: true,
      hasSwing: true,
      swingModes: ['off', 'vertical', 'horizontal', 'both'],
      swingsOnBothAxes: true,
      switchableModes: ['auto', 'cool', 'heat', 'dehumidify', 'fan'],
      lackingModes: [],
      specialModes: ['powerful', 'econo', 'streamer', 'heatPlus'],
    });
    expect(getAvailableControls(createCapabilities({ modes: ['heat'], fanSpeeds: ['auto'], swingModes: [] }))).toEqual({
      fanSteps: [],
      hasFanAuto: false,
      hasSwing: false,
      swingModes: [],
      swingsOnBothAxes: false,
      switchableModes: ['heat'],
      lackingModes: ['auto', 'cool', 'dehumidify', 'fan'],
      specialModes: [],
    });
  });

  test('should swing up and down a unit that swings only through the position of its vertical louver', () => {
    // An Airbase unit takes no swing mode: it swings at the vertical position swing.
    const airbase = createCapabilities({ swingModes: [], verticalPositions: ['position1', 'position2', 'position3', 'position4', 'position5', 'swing'] });
    expect(getSwingModes(airbase)).toEqual(['off', 'vertical']);
    expect(getAvailableControls(airbase)).toMatchObject({ hasSwing: true, swingModes: ['off', 'vertical'], swingsOnBothAxes: false });
    const fixed = createDeviceConfig({ swingControl: 'hidden', swingModeWhenHidden: 'vertical' });
    expect(fitToCapabilities(fixed, airbase)).toEqual(fixed);
    // The same unit read when it was taken to swing on both axes has other controls.
    expect(hasSameControls(airbase, { ...airbase, swingModes: ['off', 'vertical', 'horizontal', 'both'] })).toBe(false);
    // A unit that takes swing modes swings through them, whatever positions it takes.
    expect(getSwingModes(createCapabilities({ swingModes: ['off', 'horizontal'], verticalPositions: ['swing'] }))).toEqual(['off', 'horizontal']);
    expect(getSwingModes(createCapabilities({ swingModes: [], verticalPositions: ['position1'] }))).toEqual([]);
  });

  test('should count a reading from the first time a unit gives it, and keep counting it', () => {
    const nothing = { indoorTemperatureInC: 26, outdoorTemperatureInC: null, indoorHumidityInPercent: null };
    // The same object comes back when the unit gave nothing new.
    expect(addReportedSensors(noReportedSensors, nothing)).toBe(noReportedSensors);
    const humid = addReportedSensors(noReportedSensors, { ...nothing, indoorHumidityInPercent: 55 });
    expect(humid).toEqual({ hasHumidity: true, hasOutdoorTemperature: false });
    expect(addReportedSensors(humid, nothing)).toBe(humid);
    expect(addReportedSensors(humid, { ...nothing, outdoorTemperatureInC: 0 })).toEqual({ hasHumidity: true, hasOutdoorTemperature: true });
  });
});
