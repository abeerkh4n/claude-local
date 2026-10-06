import type { RunResult } from "./cli.js";

/** Reply text as it is written. Iterate it for the pieces; await `result` for the whole reply. */
export interface TextStream extends AsyncIterable<string> {
  result: Promise<RunResult>;
}

/** Starts `run` now and buffers its text until the caller iterates. */
export function textStream(run: (onText: (text: string) => void) => Promise<RunResult>): TextStream {
  const chunks: string[] = [];
  let finished = false;
  let failure: unknown;
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };

  const result = run((text) => {
    chunks.push(text);
    notify();
  }).then(
    (value) => {
      finished = true;
      notify();
      return value;
    },
    (err: unknown) => {
      finished = true;
      failure = err;
      notify();
      throw err;
    },
  );
  // The iterator rethrows the error, so a caller who only iterates still sees it.
  result.catch(() => {});

  return {
    result,
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = chunks.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (finished) {
          if (failure) throw failure;
          return;
        }
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
}
