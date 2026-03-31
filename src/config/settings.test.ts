import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSettings } from "./settings.js";

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.MOECLI_HOME;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("settings defaults", () => {
  it("creates default app settings including search config", () => {
    const dir = mkdtempSync(join(tmpdir(), "moecli-test-"));
    tempDirs.push(dir);
    process.env.MOECLI_HOME = dir;

    const settings = getSettings();

    expect(settings.browser.enabled).toBe(true);
    expect(settings.search.enabled).toBe(true);
    expect(settings.search.endpoint).toBe(
      "https://uapis.cn/api/v1/search/aggregate",
    );
    expect(settings.agents.defaultMode).toBe("background");
  });
});
