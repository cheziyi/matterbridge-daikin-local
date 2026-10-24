/**
 * @file vitest/platform/endpointIds.test.ts
 * @description This file contains the tests for the endpoint ids of a device.
 * @author Calvin Che
 */

import { EndpointIds, isStoredEndpointIds } from '../../src/platform/endpointIds.js';

describe('endpointIds', () => {
  test('should give every endpoint its base id when the device was never built before', () => {
    const ids = new EndpointIds();
    expect(ids.resolve('A4:08:EA:00:00:01')).toBe('A4:08:EA:00:00:01');
    expect(ids.resolve('A4:08:EA:00:00:01-fan')).toBe('A4:08:EA:00:00:01-fan');
    expect(ids.toStore()).toEqual({ built: ['A4:08:EA:00:00:01', 'A4:08:EA:00:00:01-fan'], generations: {} });
  });

  test('should give an endpoint that was not built last time a new id, and keep the ids of the ones that were', () => {
    const ids = new EndpointIds({ built: ['A4:08:EA:00:00:01', 'A4:08:EA:00:00:01-fan'], generations: {} });
    expect(ids.resolve('A4:08:EA:00:00:01')).toBe('A4:08:EA:00:00:01');
    expect(ids.resolve('vertical-swing')).toBe('vertical-swing-1');
    expect(ids.toStore()).toEqual({ built: ['A4:08:EA:00:00:01', 'vertical-swing'], generations: { 'vertical-swing': 1 } });

    // Built last time, the swing keeps its id. Taken away last time, the fan comes back under a new one.
    const again = new EndpointIds(ids.toStore());
    expect(again.resolve('vertical-swing')).toBe('vertical-swing-1');
    expect(again.resolve('A4:08:EA:00:00:01-fan')).toBe('A4:08:EA:00:00:01-fan-1');
    const once = new EndpointIds({ ...again.toStore(), built: ['A4:08:EA:00:00:01'] });
    expect(once.resolve('A4:08:EA:00:00:01-fan')).toBe('A4:08:EA:00:00:01-fan-2');
  });

  test('should tell stored endpoint ids from anything else', () => {
    expect(isStoredEndpointIds({ built: [], generations: {} })).toBe(true);
    expect(isStoredEndpointIds({ built: ['fan'], generations: { fan: 2 } })).toBe(true);
    expect(isStoredEndpointIds('ids')).toBe(false);
    expect(isStoredEndpointIds({ built: 'fan', generations: {} })).toBe(false);
    expect(isStoredEndpointIds({ built: [1], generations: {} })).toBe(false);
    expect(isStoredEndpointIds({ built: [], generations: [] })).toBe(false);
    expect(isStoredEndpointIds({ built: [], generations: { fan: 0 } })).toBe(false);
  });
});
