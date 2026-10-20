/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface PauseGuard extends Disposable {
  /** Resolves when every task that started before the pause has finished. */
  readonly idle: Promise<void>;
}

type Priority = 'normal' | 'high';

interface Entry {
  queue: TaskQueue;
  priority: Priority;
  running: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** The runner methods a queue uses. Not part of the public API. */
interface QueueHooks {
  run<T>(queue: TaskQueue, fn: () => Promise<T>): Promise<T>;
  cancel(queue: TaskQueue, reason: Error): void;
}

/**
 * A queue that the {@link TaskRunner} created. Tasks on one queue run one
 * at a time. Tasks on a queue and on its ancestors or descendants also run
 * one at a time. Tasks on unrelated queues run at the same time.
 */
export class TaskQueue {
  readonly parent?: TaskQueue;
  readonly #hooks: QueueHooks;
  #disposed?: Error;

  constructor(hooks: QueueHooks, parent: TaskQueue | undefined) {
    this.#hooks = hooks;
    this.parent = parent;
  }

  /** Runs `fn` when no earlier task on a related queue runs. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    return await this.#hooks.run(this, fn);
  }

  /**
   * Rejects the tasks that wait on this queue with `reason`, and rejects
   * every later `run()` call. The running task finishes.
   */
  dispose(reason: Error): void {
    this.#disposed = reason;
    this.#hooks.cancel(this, reason);
  }

  /** @internal */
  throwIfDisposed(): void {
    if (this.#disposed) {
      throw this.#disposed;
    }
  }

  /** True when `other` is this queue, an ancestor, or a descendant. */
  isRelatedTo(other: TaskQueue): boolean {
    return this.#isAncestorOrSelf(other) || other.#isAncestorOrSelf(this);
  }

  #isAncestorOrSelf(other: TaskQueue): boolean {
    for (
      let queue: TaskQueue | undefined = other;
      queue;
      queue = queue.parent
    ) {
      if (queue === this) {
        return true;
      }
    }
    return false;
  }
}

/**
 * Runs every task of the server from one ordered list. Each task names the
 * queue it runs on. A task starts when every earlier task on a related queue
 * has finished. Waiting tasks count, so a waiting task blocks later related
 * tasks and no task starves. `pause()` enters the list ahead of waiting tasks
 * and relates to every queue.
 */
export class TaskRunner {
  readonly #root: TaskQueue;
  #entries: Entry[] = [];

  constructor() {
    this.#root = this.createQueue(undefined);
  }

  /**
   * Creates a queue. Tasks on the new queue and tasks on `parent` wait for
   * each other. Without `parent`, the queue is a child of the root, so only
   * `pause()` relates to it.
   */
  createQueue(parent: TaskQueue | undefined = this.#root): TaskQueue {
    return new TaskQueue(
      {
        run: (queue, fn) => this.#run(queue, fn),
        cancel: (queue, reason) => this.#cancel(queue, reason),
      },
      parent,
    );
  }

  /**
   * Stops new tasks on every queue. Running tasks finish. The pause goes
   * ahead of waiting tasks. Disposing the guard resumes the runner.
   */
  pause(): PauseGuard {
    const {entry, started} = this.#enter(this.#root, 'high');
    return {
      idle: started,
      [Symbol.dispose]: () => {
        this.#leave(entry);
      },
    };
  }

  async #run<T>(queue: TaskQueue, fn: () => Promise<T>): Promise<T> {
    const {entry, started} = this.#enter(queue, 'normal');
    await started;
    try {
      return await fn();
    } finally {
      this.#leave(entry);
    }
  }

  #cancel(queue: TaskQueue, reason: Error): void {
    for (const entry of [...this.#entries]) {
      if (entry.queue === queue && !entry.running) {
        this.#leave(entry);
        entry.reject(reason);
      }
    }
  }

  #enter(
    queue: TaskQueue,
    priority: Priority,
  ): {entry: Entry; started: Promise<void>} {
    queue.throwIfDisposed();
    const {promise, resolve, reject} = Promise.withResolvers<void>();
    const entry: Entry = {queue, priority, running: false, resolve, reject};
    // A high-priority entry goes before the first waiting normal entry.
    const index =
      priority === 'high'
        ? this.#entries.findIndex(e => !e.running && e.priority === 'normal')
        : -1;
    this.#entries.splice(index === -1 ? this.#entries.length : index, 0, entry);
    this.#schedule();
    return {entry, started: promise};
  }

  #leave(entry: Entry): void {
    const index = this.#entries.indexOf(entry);
    if (index === -1) {
      return;
    }
    this.#entries.splice(index, 1);
    this.#schedule();
  }

  #schedule(): void {
    for (const [index, entry] of this.#entries.entries()) {
      if (entry.running) {
        continue;
      }
      const blocked = this.#entries
        .slice(0, index)
        .some(earlier => earlier.queue.isRelatedTo(entry.queue));
      if (!blocked) {
        entry.running = true;
        entry.resolve();
      }
    }
  }
}
