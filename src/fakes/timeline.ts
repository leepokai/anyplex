// A fake hosted session is a timeline: a script appends events over time regardless of who is
// listening, so tests can abandon a stream mid-session and re-attach later like the real APIs.

export interface Timeline<T> {
  readonly events: T[];
  readonly done: boolean;
  push(event: T): void;
  finish(): void;
  from(from: number, signal?: AbortSignal): AsyncGenerator<{ index: number; event: T }>;
}

export function createTimeline<T>(): Timeline<T> {
  const events: T[] = [];
  let done = false;
  let waiters: (() => void)[] = [];
  const wake = () => {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };
  return {
    events,
    get done() {
      return done;
    },
    push(event) {
      events.push(event);
      wake();
    },
    finish() {
      done = true;
      wake();
    },
    async *from(from, signal) {
      let index = from;
      for (;;) {
        while (index < events.length) {
          yield { index, event: events[index] as T };
          index += 1;
        }
        if (done || signal?.aborted) return;
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    },
  };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let counter = 0;
export const fakeId = (prefix: string) => `${prefix}_fake_${++counter}`;
export const now = () => new Date().toISOString();

export interface FakeServer<S> {
  url: string;
  state: S;
  close: () => Promise<void>;
}
