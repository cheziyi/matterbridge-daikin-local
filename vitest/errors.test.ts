/**
 * @file vitest/errors.test.ts
 * @description This file contains the tests for the helpers that describe errors.
 * @author Calvin Che
 */

import { getErrorMessage } from '../src/errors.js';

describe('errors', () => {
  it('should describe any thrown value in one line', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
    expect(getErrorMessage('plain')).toBe('plain');
  });
});
