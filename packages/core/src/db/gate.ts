/**
 * Writer-preference reader/writer gate.
 *
 * Shared holders (ordinary repo calls) run concurrently with each other. An exclusive holder
 * (a transaction) waits for in-flight shared holders to drain, and blocks new ones until it
 * releases. Waiters are served in FIFO order, so a queued transaction cannot be starved.
 */
export class Gate {
  #readers = 0;
  #writer = false;
  #queue: { exclusive: boolean; grant: () => void }[] = [];

  shared(): Promise<() => void> {
    return this.#acquire(false);
  }

  exclusive(): Promise<() => void> {
    return this.#acquire(true);
  }

  #acquire(exclusive: boolean): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        if (exclusive) this.#writer = true;
        else this.#readers++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          if (exclusive) this.#writer = false;
          else this.#readers--;
          this.#drain();
        });
      };
      this.#queue.push({ exclusive, grant });
      this.#drain();
    });
  }

  #drain(): void {
    for (;;) {
      const head = this.#queue[0];
      if (!head) return;
      const ok = head.exclusive ? !this.#writer && this.#readers === 0 : !this.#writer;
      if (!ok) return;
      this.#queue.shift();
      head.grant();
    }
  }
}
