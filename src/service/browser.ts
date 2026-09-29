import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

export interface BrowserBundle { browser: Browser; context: BrowserContext; page: Page }

/**
 * Phase 1: one visible Chromium, one context, one page. Headless only when the
 * HEADLESS=1 env var is set (used for automated container testing, never by default).
 */
export async function launchBrowser(): Promise<BrowserBundle> {
  const headless = process.env.HEADLESS === '1';
  const browser = await chromium.launch({
    headless,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    // Give the visible window a sensible size; viewport null lets the page use it.
    args: headless ? [] : ['--window-size=1280,900', '--window-position=40,40'],
  });
  const context = await browser.newContext({ viewport: headless ? { width: 1280, height: 900 } : null });
  const page = await context.newPage();
  return { browser, context, page };
}
