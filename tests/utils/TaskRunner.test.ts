/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {TaskRunner, type TaskQueue} from '../../src/utils/TaskRunner.js';

async function settle(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

interface ControlledTask {
  /** True once the task body runs. */
  started: boolean;
  /** Settles when the task has finished. */
  done: Promise<void>;
  /** Lets the task body return. */
  finish: () => void;
}

/** Starts a task on `queue` that blocks until `finish()` is called. */
function start(queue: TaskQueue): ControlledTask {
  const {promise: release, resolve: finish} = Promise.withResolvers<void>();
  const controlled: ControlledTask = {
    started: false,
    done: Promise.resolve(),
    finish,
  };
  controlled.done = queue.run(async () => {
    controlled.started = true;
    await release;
  });
  return controlled;
}

function createTree() {
  const runner = new TaskRunner();
  const parent = runner.createQueue();
  const childA = runner.createQueue(parent);
  const childB = runner.createQueue(parent);
  return {runner, parent, childA, childB};
}

describe('TaskRunner', () => {
  it('runs tasks on unrelated queues at the same time', async () => {
    const {childA, childB} = createTree();
    const a = start(childA);
    const b = start(childB);
    await settle();
    assert.strictEqual(a.started, true);
    assert.strictEqual(b.started, true);
    a.finish();
    b.finish();
    await Promise.all([a.done, b.done]);
  });

  it('runs tasks on queues of different roots at the same time', async () => {
    const runner = new TaskRunner();
    const a = start(runner.createQueue());
    const b = start(runner.createQueue());
    await settle();
    assert.strictEqual(a.started, true);
    assert.strictEqual(b.started, true);
    a.finish();
    b.finish();
    await Promise.all([a.done, b.done]);
  });

  it('serializes tasks on one queue in FIFO order', async () => {
    const queue = new TaskRunner().createQueue();
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map(id =>
        queue.run(async () => {
          await settle();
          order.push(id);
        }),
      ),
    );
    assert.deepStrictEqual(order, [1, 2, 3]);
  });

  it('makes a parent task wait for a running child task', async () => {
    const {parent, childA} = createTree();
    const child = start(childA);
    const parentTask = start(parent);
    await settle();
    assert.strictEqual(parentTask.started, false);
    child.finish();
    await settle();
    assert.strictEqual(parentTask.started, true);
    parentTask.finish();
    await Promise.all([child.done, parentTask.done]);
  });

  it('makes a child task wait for a running parent task', async () => {
    const {parent, childA} = createTree();
    const parentTask = start(parent);
    const child = start(childA);
    await settle();
    assert.strictEqual(child.started, false);
    parentTask.finish();
    await settle();
    assert.strictEqual(child.started, true);
    child.finish();
    await Promise.all([child.done, parentTask.done]);
  });

  it('blocks a later child task behind a waiting parent task', async () => {
    const {parent, childA, childB} = createTree();
    const a = start(childA);
    const parentTask = start(parent);
    const b = start(childB);
    await settle();
    assert.strictEqual(b.started, false);
    a.finish();
    await settle();
    assert.strictEqual(parentTask.started, true);
    assert.strictEqual(b.started, false);
    parentTask.finish();
    await settle();
    assert.strictEqual(b.started, true);
    b.finish();
    await Promise.all([a.done, parentTask.done, b.done]);
  });

  it('returns the task result', async () => {
    const queue = new TaskRunner().createQueue();
    assert.strictEqual(await queue.run(async () => 42), 42);
  });

  it('releases the queue when the task throws', async () => {
    const queue = new TaskRunner().createQueue();
    await assert.rejects(
      queue.run(async () => {
        throw new Error('task failed');
      }),
      /task failed/,
    );
    const next = start(queue);
    await settle();
    assert.strictEqual(next.started, true);
    next.finish();
    await next.done;
  });

  describe('pause', () => {
    it('stops new tasks and resolves idle after running tasks finish', async () => {
      const {runner, childA, childB} = createTree();
      const running = start(childA);
      await settle();
      using guard = runner.pause();
      let idle = false;
      void guard.idle.then(() => {
        idle = true;
      });
      const late = start(childB);
      await settle();
      assert.strictEqual(idle, false);
      assert.strictEqual(late.started, false);
      running.finish();
      await running.done;
      await settle();
      assert.strictEqual(idle, true);
      assert.strictEqual(late.started, false);
      guard[Symbol.dispose]();
      await settle();
      assert.strictEqual(late.started, true);
      late.finish();
      await late.done;
    });

    it('goes ahead of waiting tasks', async () => {
      const {runner, childA} = createTree();
      const running = start(childA);
      const waiting = start(childA);
      await settle();
      using guard = runner.pause();
      running.finish();
      await guard.idle;
      await settle();
      assert.strictEqual(waiting.started, false);
      guard[Symbol.dispose]();
      await settle();
      assert.strictEqual(waiting.started, true);
      waiting.finish();
      await Promise.all([running.done, waiting.done]);
    });
  });

  describe('dispose', () => {
    it('rejects waiting tasks with the reason and keeps the running task', async () => {
      const queue = new TaskRunner().createQueue();
      const running = start(queue);
      const waiting = start(queue);
      await settle();
      queue.dispose(new Error('Page 1 is closed.'));
      await assert.rejects(waiting.done, /Page 1 is closed\./);
      assert.strictEqual(running.started, true);
      running.finish();
      await running.done;
    });

    it('rejects a later run', async () => {
      const queue = new TaskRunner().createQueue();
      queue.dispose(new Error('Page 1 is closed.'));
      await assert.rejects(
        queue.run(async () => {}),
        /Page 1 is closed\./,
      );
    });

    it('lets a parent task run after a waiting child task is rejected', async () => {
      const {parent, childA} = createTree();
      const running = start(childA);
      const waiting = start(childA);
      await settle();
      childA.dispose(new Error('closed'));
      await assert.rejects(waiting.done, /closed/);
      running.finish();
      await running.done;
      const parentTask = start(parent);
      await settle();
      assert.strictEqual(parentTask.started, true);
      parentTask.finish();
      await parentTask.done;
    });
  });
});
