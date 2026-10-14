import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../service.js', () => ({ HyperfyService: { serviceType: 'hyperfy' } }));

const launched: any[] = [];
let failNextLaunch = false;
vi.mock('puppeteer', () => {
  const makePage = () => ({
    goto: vi.fn().mockResolvedValue(undefined),
    addScriptTag: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  });
  return {
    default: {
      launch: vi.fn(async () => {
        if (failNextLaunch) {
          failNextLaunch = false;
          throw new Error('no chromium');
        }
        const browser = {
          pages: [] as any[],
          newPage: vi.fn(async () => {
            const page = makePage();
            browser.pages.push(page);
            return page;
          }),
          close: vi.fn().mockResolvedValue(undefined),
          on: vi.fn(),
        };
        launched.push(browser);
        return browser;
      }),
    },
  };
});
// injectScripts reads the bundled scripts; their content doesn't matter here.
vi.mock('fs', async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, promises: { ...actual.promises, readFile: vi.fn().mockResolvedValue('') } };
});

import { PuppeteerManager } from './puppeteer-manager';

describe('PuppeteerManager', () => {
  afterEach(async () => {
    await (PuppeteerManager as any).instance?.close();
    launched.length = 0;
  });

  it('reuses one browser across sessions and gives each session a fresh page', async () => {
    const manager = PuppeteerManager.getOrCreate({} as any);
    expect(PuppeteerManager.getOrCreate({} as any)).toBe(manager);

    await (manager as any).init();
    await manager.resetPage();
    await (manager as any).init();

    expect(launched).toHaveLength(1);
    const [browser] = launched;
    expect(browser.pages).toHaveLength(2);
    expect(browser.pages[0].close).toHaveBeenCalled();
    expect(browser.pages[1].close).not.toHaveBeenCalled();
  });

  it('close() closes the browser and allows a new manager', async () => {
    const manager = PuppeteerManager.getOrCreate({} as any);
    await (manager as any).init();
    await manager.close();

    expect(launched[0].close).toHaveBeenCalled();
    expect(PuppeteerManager.getOrCreate({} as any)).not.toBe(manager);
  });

  it('retries the launch after a failure instead of rethrowing it forever', async () => {
    failNextLaunch = true;
    const manager = PuppeteerManager.getOrCreate({} as any);
    await vi.waitFor(() => expect((manager as any).initPromise).toBeNull());

    await (manager as any).init();
    expect(launched).toHaveLength(1);
  });

  it('refuses a second constructor call', () => {
    PuppeteerManager.getOrCreate({} as any);
    expect(() => new PuppeteerManager({} as any)).toThrow('already been instantiated');
  });
});
