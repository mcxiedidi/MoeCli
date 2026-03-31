import { PassThrough } from "node:stream";
import { stdin } from "node:process";
import type { Interface as ReadlineInterface } from "node:readline/promises";

const SHIFT_TAB_SEQUENCE = "\u001b[Z";

export interface ShiftTabSplitResult {
  forward: string;
  carry: string;
  count: number;
}

export interface ReplInputRouter {
  input: PassThrough;
  dispose: () => void;
}

export function splitShiftTabSequence(
  raw: string,
  carry = "",
): ShiftTabSplitResult {
  const combined = `${carry}${raw}`;
  let forward = "";
  let buffered = "";
  let count = 0;

  for (let index = 0; index < combined.length; index += 1) {
    const remaining = combined.slice(index);
    if (remaining.startsWith(SHIFT_TAB_SEQUENCE)) {
      count += 1;
      index += SHIFT_TAB_SEQUENCE.length - 1;
      continue;
    }

    if (SHIFT_TAB_SEQUENCE.startsWith(remaining)) {
      buffered = remaining;
      break;
    }

    forward += combined[index] ?? "";
  }

  return {
    forward,
    carry: buffered,
    count,
  };
}

export function createReplInputRouter(
  onShiftTab: () => void,
): ReplInputRouter {
  const input = new PassThrough();
  (input as PassThrough & { isTTY?: boolean }).isTTY = stdin.isTTY;
  let carry = "";

  const onData = (chunk: string | Buffer): void => {
    const text =
      typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const split = splitShiftTabSequence(text, carry);
    carry = split.carry;

    if (split.forward) {
      input.write(split.forward);
    }

    for (let index = 0; index < split.count; index += 1) {
      onShiftTab();
    }
  };

  const onEnd = (): void => {
    if (carry) {
      input.write(carry);
      carry = "";
    }
    input.end();
  };

  if (stdin.isTTY && typeof stdin.setRawMode === "function") {
    stdin.setRawMode(true);
  }
  stdin.resume();
  stdin.on("data", onData);
  stdin.on("end", onEnd);

  return {
    input,
    dispose: () => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      if (stdin.isTTY && typeof stdin.setRawMode === "function") {
        stdin.setRawMode(false);
      }
    },
  };
}

export function refreshActivePrompt(
  rl: ReadlineInterface,
  prompt: string,
): void {
  rl.setPrompt(prompt);
  const refresh = (
    rl as ReadlineInterface & {
      _refreshLine?: (() => void) | undefined;
    }
  )._refreshLine;

  if (typeof refresh === "function") {
    refresh.call(rl);
    return;
  }

  rl.prompt(true);
}
