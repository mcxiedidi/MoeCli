import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { getSelfLaunchCommand, shouldDetachAgentProcess } from "./manager.js";

const tempDirs: string[] = [];

function createTempPackageRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "moecli-agent-manager-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("agent manager launch helpers", () => {
  it("does not detach agent processes on Windows", () => {
    expect(shouldDetachAgentProcess("win32")).toBe(false);
    expect(shouldDetachAgentProcess("linux")).toBe(true);
  });

  it("prefers the packaged dist entry when it exists", () => {
    const packageRoot = createTempPackageRoot();
    const distEntry = join(packageRoot, "dist", "index.js");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(distEntry, "console.log('ok');\n", "utf8");

    const launch = getSelfLaunchCommand(packageRoot);

    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual([distEntry]);
  });

  it("uses node with the tsx loader in source mode", () => {
    const packageRoot = createTempPackageRoot();
    const loaderPath = join(packageRoot, "node_modules", "tsx", "dist", "loader.mjs");
    const srcEntry = join(packageRoot, "src", "index.ts");
    mkdirSync(join(packageRoot, "node_modules", "tsx", "dist"), {
      recursive: true,
    });
    mkdirSync(join(packageRoot, "src"), { recursive: true });
    writeFileSync(loaderPath, "export {};\n", "utf8");
    writeFileSync(srcEntry, "console.log('ok');\n", "utf8");

    const launch = getSelfLaunchCommand(packageRoot);

    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual(["--import", loaderPath, srcEntry]);
  });
});
