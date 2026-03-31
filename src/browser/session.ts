import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { getCacheDir } from "../config/paths.js";
import { getSettings } from "../config/settings.js";

export interface BrowserStatus {
  enabled: boolean;
  available: boolean;
  connected: boolean;
  executablePath?: string | undefined;
  currentUrl?: string | undefined;
  title?: string | undefined;
  message: string;
}

function findBrowserExecutable(): string | undefined {
  const explicit = process.env.BROWSER_EXECUTABLE_PATH?.trim();
  if (explicit && existsSync(explicit)) {
    return explicit;
  }

  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
            "/usr/bin/microsoft-edge",
          ];

  return candidates.find((candidate) => existsSync(candidate));
}

export class BrowserSession {
  private browser: Browser | null = null;
  private page: Page | null = null;

  async getStatus(): Promise<BrowserStatus> {
    const enabled = getSettings().browser.enabled;
    const executablePath = findBrowserExecutable();

    if (!enabled) {
      return {
        enabled,
        available: Boolean(executablePath),
        connected: false,
        executablePath,
        message: "Browser integration is disabled in MoeCli settings.",
      };
    }

    if (!executablePath) {
      return {
        enabled,
        available: false,
        connected: false,
        message:
          "No local Chrome/Chromium executable was found. Set BROWSER_EXECUTABLE_PATH if needed.",
      };
    }

    return {
      enabled,
      available: true,
      connected: Boolean(this.browser && this.page),
      executablePath,
      ...(this.page ? { currentUrl: this.page.url() } : {}),
      ...(this.page ? { title: await this.page.title().catch(() => "") } : {}),
      message: this.browser
        ? "Browser session is ready."
        : "Browser is available but not launched yet.",
    };
  }

  async ensurePage(): Promise<Page> {
    const settings = getSettings();
    if (!settings.browser.enabled) {
      throw new Error("Browser integration is disabled.");
    }

    if (this.page) {
      return this.page;
    }

    const executablePath = findBrowserExecutable();
    if (!executablePath) {
      throw new Error(
        "No local Chrome/Chromium executable was found. Set BROWSER_EXECUTABLE_PATH to override detection.",
      );
    }

    this.browser = await chromium.launch({
      executablePath,
      headless: true,
    });
    const context = await this.browser.newContext();
    this.page = await context.newPage();
    return this.page;
  }

  async open(url: string): Promise<BrowserStatus> {
    const page = await this.ensurePage();
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    return this.getStatus();
  }

  async snapshot(url?: string): Promise<{
    url: string;
    title: string;
    text: string;
  }> {
    const page = await this.ensurePage();
    if (url?.trim()) {
      await this.open(url.trim());
    }
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    return {
      url: page.url(),
      title: await page.title(),
      text: text.slice(0, 20_000),
    };
  }

  async screenshot(targetPath?: string): Promise<string> {
    const page = await this.ensurePage();
    const outputPath =
      targetPath?.trim() ||
      join(getCacheDir(), `browser-${Date.now()}.png`);
    await page.screenshot({
      path: outputPath,
      fullPage: true,
    });
    return outputPath;
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
    this.page = null;
  }
}

let singleton: BrowserSession | null = null;

export function getBrowserSession(): BrowserSession {
  singleton ??= new BrowserSession();
  return singleton;
}
