/**
 * @file src/accessory/endpoints.ts
 * @description This file contains the builders of the Matter endpoints of one air conditioner.
 * @author Calvin Che
 * @created 2026-10-13
 * @version 1.0.0
 * @license Apache-2.0
 *
 * Copyright 2026 Calvin Che.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { bridgedNode, type DeviceTypeDefinition, fan, MatterbridgeEndpoint, onOffPlugInUnit, powerSource, roomAirConditioner, temperatureSensor } from 'matterbridge';
import { MatterbridgeFanControlServer } from 'matterbridge/behaviors';
import { FanControl } from 'matterbridge/matter/clusters';

import { clampTemperature, composeDeviceName, getFanModeSequence } from '../mapping.js';
import type { AccessoryLayout } from './layout.js';

const vendorName = 'Daikin';

/** What every endpoint of a device says about the device it belongs to. */
export interface EndpointIdentity {
  /** The device name. */
  name: string;
  /** The serial number of the device: the MAC address of its adapter, which neither a new address nor a new name changes. */
  serial: string;
  /** The vendor id of the bridge, used for the bridged device information. */
  vendorId: number;
}

/**
 * Add the fan control of a device, with the features its unit has
 *
 * @param {MatterbridgeEndpoint} endpoint The air conditioner, or the fan of a device that has one of its own.
 * @param {AccessoryLayout} layout How the controls of the device are laid out.
 * @returns {void}
 */
function addFanControl(endpoint: MatterbridgeEndpoint, layout: AccessoryLayout): void {
  // Off and 0 are valid in every sequence; the first read replaces them with the unit's own speed.
  const base = {
    fanMode: FanControl.FanMode.Off,
    fanModeSequence: getFanModeSequence(layout.fanSteps.length, layout.hasFanAuto),
    percentSetting: 0,
    percentCurrent: 0,
  };
  const speeds = { speedMax: layout.fanSteps.length, speedSetting: 0, speedCurrent: 0 };
  if (layout.hasFanSteps && layout.hasFanAuto) {
    endpoint.behaviors.require(MatterbridgeFanControlServer.with(FanControl.Feature.MultiSpeed, FanControl.Feature.Auto), { ...base, ...speeds });
  } else if (layout.hasFanSteps) {
    endpoint.behaviors.require(MatterbridgeFanControlServer.with(FanControl.Feature.MultiSpeed), { ...base, ...speeds });
  } else if (layout.hasFanAuto) {
    endpoint.behaviors.require(MatterbridgeFanControlServer.with(FanControl.Feature.Auto), base);
  } else {
    endpoint.behaviors.require(MatterbridgeFanControlServer.with(), base);
  }
}

/**
 * Create the room air conditioner of a device: on/off, a thermostat for what its unit does and, when they are exposed
 * there, a fan control and the indoor humidity
 *
 * @param {EndpointIdentity} identity The device the endpoint belongs to.
 * @param {AccessoryLayout} layout How the controls of the device are laid out.
 * @returns {MatterbridgeEndpoint} The endpoint, with its clusters and nothing subscribed yet.
 */
export function createAirConditionerEndpoint(identity: EndpointIdentity, layout: AccessoryLayout): MatterbridgeEndpoint {
  const endpoint = new MatterbridgeEndpoint([roomAirConditioner, bridgedNode, powerSource], { id: identity.serial })
    .createDefaultIdentifyClusterServer()
    .createDefaultBridgedDeviceBasicInformationClusterServer(identity.name, identity.serial, identity.vendorId, vendorName, 'Daikin Air Conditioner')
    .createDefaultPowerSourceWiredClusterServer()
    .createDeadFrontOnOffClusterServer(false);

  const { profile, heatLimits, coolLimits } = layout;
  const heatSetpoint = clampTemperature(21, heatLimits);
  const coolSetpoint = clampTemperature(25, coolLimits);
  if (profile === 'heatCool') {
    endpoint.createDefaultThermostatClusterServer(23, Math.min(heatSetpoint, coolSetpoint), coolSetpoint, 0, heatLimits.min, heatLimits.max, coolLimits.min, coolLimits.max);
  } else if (profile === 'cool') {
    endpoint.createDefaultCoolingThermostatClusterServer(23, coolSetpoint, coolLimits.min, coolLimits.max);
  } else {
    endpoint.createDefaultHeatingThermostatClusterServer(23, heatSetpoint, heatLimits.min, heatLimits.max);
  }
  if (layout.hasFan && !layout.hasSeparateFan) addFanControl(endpoint, layout);
  // No value until the first read.
  if (layout.hasHumidity) endpoint.createDefaultRelativeHumidityMeasurementClusterServer(null);
  endpoint.addRequiredClusters();
  return endpoint;
}

/**
 * Create an endpoint of a device beside its air conditioner, without the clusters of its device type
 *
 * @param {DeviceTypeDefinition} deviceType What the endpoint is in Matter.
 * @param {EndpointIdentity} identity The device the endpoint belongs to.
 * @param {string} key What tells the endpoint apart in the endpoint id, such as `fan-auto`.
 * @param {string} code What tells the endpoint apart in the serial number: one letter.
 * @param {string} label What the endpoint is, such as `Auto Fan`. It follows the device name in the name of the endpoint.
 * @returns {MatterbridgeEndpoint} The endpoint.
 */
function createExtraEndpoint(deviceType: DeviceTypeDefinition, identity: EndpointIdentity, key: string, code: string, label: string): MatterbridgeEndpoint {
  return new MatterbridgeEndpoint([deviceType, bridgedNode, powerSource], { id: `${identity.serial}-${key}` })
    .createDefaultIdentifyClusterServer()
    .createDefaultBridgedDeviceBasicInformationClusterServer(composeDeviceName(identity.name, label), `${identity.serial}${code}`, identity.vendorId, vendorName, `Daikin ${label}`)
    .createDefaultPowerSourceWiredClusterServer();
}

/**
 * Create one on/off switch of a device
 *
 * An outlet is the on/off device type every Matter app shows.
 *
 * @param {EndpointIdentity} identity The device the endpoint belongs to.
 * @param {string} key What tells the switch apart in the endpoint id, such as `fan-auto`.
 * @param {string} code What tells the switch apart in the serial number: one letter.
 * @param {string} label What the switch is, such as `Auto Fan`. It follows the device name in the name of the switch.
 * @returns {MatterbridgeEndpoint} The endpoint, with its clusters and nothing subscribed yet.
 */
export function createSwitchEndpoint(identity: EndpointIdentity, key: string, code: string, label: string): MatterbridgeEndpoint {
  return createExtraEndpoint(onOffPlugInUnit, identity, key, code, label).addRequiredClusters();
}

/**
 * Create the fan of a device whose fan control is not a part of its air conditioner
 *
 * @param {EndpointIdentity} identity The device the endpoint belongs to.
 * @param {AccessoryLayout} layout How the controls of the device are laid out.
 * @returns {MatterbridgeEndpoint} The endpoint, with its clusters and nothing subscribed yet.
 */
export function createFanEndpoint(identity: EndpointIdentity, layout: AccessoryLayout): MatterbridgeEndpoint {
  const endpoint = createExtraEndpoint(fan, identity, 'fan', 'N', 'Fan');
  addFanControl(endpoint, layout);
  return endpoint.addRequiredClusters();
}

/**
 * Create the outdoor temperature sensor of a device
 *
 * The air conditioner cannot show it: a second temperature there would be taken for that of the room.
 *
 * @param {EndpointIdentity} identity The device the endpoint belongs to.
 * @returns {MatterbridgeEndpoint} The endpoint, with no value until the first read.
 */
export function createOutdoorTemperatureEndpoint(identity: EndpointIdentity): MatterbridgeEndpoint {
  return createExtraEndpoint(temperatureSensor, identity, 'outdoor-temperature', 'O', 'Outdoor Temperature')
    .createDefaultTemperatureMeasurementClusterServer(null)
    .addRequiredClusters();
}
