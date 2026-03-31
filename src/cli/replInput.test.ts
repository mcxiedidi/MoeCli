import { describe, expect, it } from "vitest";
import { splitShiftTabSequence } from "./replInput.js";

describe("repl input router", () => {
  it("strips shift-tab escape sequences from forwarded input", () => {
    expect(splitShiftTabSequence("hello\u001b[Zworld")).toEqual({
      forward: "helloworld",
      carry: "",
      count: 1,
    });
  });

  it("buffers incomplete shift-tab sequences between chunks", () => {
    expect(splitShiftTabSequence("\u001b[", "")).toEqual({
      forward: "",
      carry: "\u001b[",
      count: 0,
    });
    expect(splitShiftTabSequence("Z", "\u001b[")).toEqual({
      forward: "",
      carry: "",
      count: 1,
    });
  });
});
