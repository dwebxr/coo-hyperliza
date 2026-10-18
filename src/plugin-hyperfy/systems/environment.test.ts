import { afterEach, describe, expect, it, vi } from 'vitest';

// The rejection handler does not need a render page or the service it belongs to.
vi.mock('../managers/puppeteer-manager.js', () => ({ PuppeteerManager: {} }));

import { AgentEnvironment } from './environment';

const prototype = AgentEnvironment.prototype as any;

function refreshSky(error: Error) {
  const environment = {
    updateSky: vi.fn().mockRejectedValue(error),
    reportRenderError: prototype.reportRenderError,
  };
  prototype.refreshSky.call(environment);
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe('AgentEnvironment render errors', () => {
  afterEach(() => vi.restoreAllMocks());

  it('handles a closed render page at debug level without an unhandled rejection', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const error = new Error('render page closed');
      error.name = 'TargetCloseError';
      await refreshSky(error);

      expect(debug).toHaveBeenCalledTimes(1);
      expect(debug).toHaveBeenCalledWith('[Environment] sky update stopped: the render page was closed');
      expect(warn).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('warns about other sky update failures', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await refreshSky(new Error('texture failed'));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[Environment] Could not update the sky:', 'texture failed');
    expect(debug).not.toHaveBeenCalled();
  });
});
