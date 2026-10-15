/**
 * @file vitest/accessory/factoryReset.test.ts
 * @description This file contains the tests for a device that outlives a factory reset of the Matter node.
 * @author Calvin Che
 */

/**
 * WARNING!!!
 * The tests in this unit are supposed to run sequentially because they depend on the Matter state.
 * The node is reset to factory defaults, so they have a server node of their own.
 */

import type { MatterbridgeEndpoint } from 'matterbridge';
import type { ActionContext } from 'matterbridge/matter';
import { OnOff } from 'matterbridge/matter/clusters';
import { log, setupTest } from 'matterbridge/vitest-utils';
import { addDevice, aggregator, createServerNode, createTestEnvironment, server, startServerNode, stopServerNode } from 'matterbridge/vitest-utils/matter';

import { DaikinAccessory } from '../../src/accessory/daikinAccessory.js';
import { createCapabilities, createDeviceConfig, createFakeClient, type FakeClient } from '../fakeDaikin.js';

const online = { fabric: 1 } as unknown as ActionContext;
const vendorId = 0xfff1;

/**
 * Write an attribute the way a controller does: the value lands, then the change is announced with a fabric
 *
 * @param {MatterbridgeEndpoint} endpoint The endpoint.
 * @param {string} cluster The cluster name.
 * @param {string} attribute The attribute name.
 * @param {unknown} value The value to write.
 * @returns {Promise<void>} Resolves when the change is announced.
 */
async function writeAsController(endpoint: MatterbridgeEndpoint, cluster: string, attribute: string, value: unknown): Promise<void> {
  const previous: unknown = endpoint.getAttribute(cluster, attribute);
  await endpoint.setAttribute(cluster, attribute, value as never);
  const events = endpoint.eventsOf(cluster.charAt(0).toLowerCase() + cluster.slice(1)) as Record<string, { emit: (...parameters: unknown[]) => void } | undefined>;
  events[`${attribute}$Changed`]?.emit(value, previous, online);
}

await setupTest('FactoryReset', false);

describe('a device when the Matter node is reset to factory defaults', () => {
  let client: FakeClient;
  let accessory: DaikinAccessory;

  beforeAll(async () => {
    await createTestEnvironment();
    await createServerNode(6103);
    await startServerNode();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await accessory.dispose();
    await stopServerNode();
    vi.restoreAllMocks();
  });

  it('should take the writes of a controller before the reset', async () => {
    client = createFakeClient({ fanSpeed: 'level3' });
    const config = createDeviceConfig({ name: 'Lounge', swingControl: 'hidden', hasSeparateFan: true, fanAutoControl: 'switch' });
    accessory = new DaikinAccessory({ config, capabilities: createCapabilities(), client, log, vendorId, commandDelayInMs: 500 });
    for (const endpoint of accessory.endpoints) expect(await addDevice(aggregator, endpoint)).toBe(true);
    await accessory.refresh();
    await writeAsController(accessory.endpoint, 'OnOff', 'onOff', false);
    await accessory.flushCommands();
    expect(client.setState).toHaveBeenCalledExactlyOnceWith({ power: false });
  });

  it('should subscribe again once the node is back, and write the state of the unit again', async () => {
    client.state.power = true;
    const info = vi.spyOn(log, 'info');
    await server.erase();
    await vi.waitFor(() => expect(info).toHaveBeenCalledWith('"Lounge" is subscribed again after the Matter node was reset'), { timeout: 5000 });
    // The reset put the air conditioner back to off: the state of the unit replaces it.
    await vi.waitFor(() => expect(accessory.endpoint.getAttribute(OnOff, 'onOff')).toBe(true), { timeout: 5000 });
    await vi.waitFor(() => expect(accessory.fan?.getAttribute(OnOff, 'onOff')).toBe(true), { timeout: 5000 });
  });

  it('should take the writes of a controller to each endpoint after the reset', async () => {
    if (accessory.fan === undefined || accessory.fanAutoSwitch === undefined) throw new Error('The fan or the auto fan switch is missing');
    await writeAsController(accessory.endpoint, 'OnOff', 'onOff', false);
    await accessory.flushCommands();
    expect(client.setState).toHaveBeenLastCalledWith({ power: false });

    await writeAsController(accessory.fan, 'OnOff', 'onOff', true);
    await accessory.flushCommands();
    expect(client.setState).toHaveBeenLastCalledWith({ power: true });

    await writeAsController(accessory.fanAutoSwitch, 'OnOff', 'onOff', true);
    await accessory.flushCommands();
    expect(client.setState).toHaveBeenLastCalledWith({ fanSpeed: 'auto' });
    // Each write was taken once: the reset left no subscription behind twice.
    expect(client.setState).toHaveBeenCalledTimes(3);
  });
});
