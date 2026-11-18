/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import sinon from 'sinon';

describe('setup fake timers guard', () => {
  it('leaves setImmediate and nextTick unfaked when called without arguments', async () => {
    const clock = sinon.useFakeTimers();
    let timeoutFired = false;
    setTimeout(() => {
      timeoutFired = true;
    }, 50);

    let immediateFired = false;
    await new Promise<void>(resolve => {
      setImmediate(() => {
        immediateFired = true;
        resolve();
      });
    });

    let nextTickFired = false;
    await new Promise<void>(resolve => {
      process.nextTick(() => {
        nextTickFired = true;
        resolve();
      });
    });

    assert.strictEqual(immediateFired, true);
    assert.strictEqual(nextTickFired, true);
    assert.strictEqual(timeoutFired, false);
    await clock.tickAsync(50);
    assert.strictEqual(timeoutFired, true);
  });

  it('leaves setImmediate unfaked when called with a timestamp or Date', async () => {
    sinon.useFakeTimers(12_345);
    assert.strictEqual(Date.now(), 12_345);
    await new Promise<void>(resolve => setImmediate(resolve));

    sinon.restore();
    sinon.useFakeTimers(new Date('2026-01-02T00:00:00.000Z'));
    assert.strictEqual(Date.now(), Date.parse('2026-01-02T00:00:00.000Z'));
    await new Promise<void>(resolve => setImmediate(resolve));
  });

  it('leaves setImmediate unfaked when config omits toFake and toNotFake', async () => {
    sinon.useFakeTimers({now: 9_000});
    assert.strictEqual(Date.now(), 9_000);
    await new Promise<void>(resolve => setImmediate(resolve));
  });

  it('preserves explicit toFake and toNotFake overrides when requested', () => {
    const fakeImmediateClock = sinon.useFakeTimers({toFake: ['setImmediate']});
    try {
      let ran = false;
      setImmediate(() => {
        ran = true;
      });
      assert.strictEqual(ran, false);
      fakeImmediateClock.runAll();
      assert.strictEqual(ran, true);
    } finally {
      fakeImmediateClock.restore();
    }

    const customNotFakeClock = sinon.useFakeTimers({
      toNotFake: ['setTimeout'],
    });
    try {
      let immediateRan = false;
      setImmediate(() => {
        immediateRan = true;
      });
      assert.strictEqual(immediateRan, false);
      customNotFakeClock.runAll();
      assert.strictEqual(immediateRan, true);
    } finally {
      customNotFakeClock.restore();
    }
  });
});
