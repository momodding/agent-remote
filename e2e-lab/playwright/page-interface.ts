/**
 * Minimal Page interface for type safety without importing @playwright/test.
 * Extracted to avoid triggering Playwright test registry during import.
 */
export interface Page {
  goto(url: string, options?: { waitUntil?: string }): Promise<void>;
  locator(selector: string): Locator;
}

export interface Locator {
  first(): Locator;
  click(): Promise<void>;
  fill(text: string): Promise<void>;
  getAttribute(name: string): Promise<string | null>;
  isVisible(): Promise<boolean>;
  waitFor(options?: { state?: string; timeout?: number }): Promise<void>;
}
