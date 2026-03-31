import { describe, expect, it } from "vitest";
import {
  createAutonomousToolPermissionState,
  createToolPermissionState,
} from "./permissions.js";

describe("tool permission states", () => {
  it("creates interactive approval state by default", () => {
    const state = createToolPermissionState();

    expect(state.allowAllSession).toBe(false);
    expect(state.allowAllNextTurn).toBe(false);
  });

  it("creates autonomous worker state for sub-agents", () => {
    const state = createAutonomousToolPermissionState();

    expect(state.allowAllSession).toBe(true);
    expect(state.allowAllNextTurn).toBe(false);
  });
});
