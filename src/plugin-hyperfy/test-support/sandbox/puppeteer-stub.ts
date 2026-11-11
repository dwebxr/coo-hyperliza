// Stands in for managers/puppeteer-manager in the sandbox child process. The agent hands the model
// bytes it downloaded to Chromium and gets them back without textures; here they come back as
// they are, through the caller's acceptance step as the real manager does (pageCall).
type Options = { accept?: (bytes: Uint8Array) => unknown };

const manager = {
  async loadGlbBytes(bytes: Uint8Array, { accept }: Options = {}): Promise<unknown> {
    return accept ? accept(bytes) : bytes;
  },
  async loadVRMBytes(bytes: Uint8Array, _url: string, { accept }: Options = {}): Promise<unknown> {
    return accept ? accept(bytes) : bytes;
  },
};

export const PuppeteerManager = {
  getInstance: () => manager,
  getOrCreate: () => manager,
};
