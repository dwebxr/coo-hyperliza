// Stands in for managers/puppeteer-manager in the sandbox child process. The agent hands the model
// bytes it downloaded to Chromium and gets them back without textures; here they come back as
// they are.
const manager = {
  async loadGlbBytes(bytes: Uint8Array): Promise<Uint8Array> {
    return bytes;
  },
  async loadVRMBytes(bytes: Uint8Array, _url: string): Promise<Uint8Array> {
    return bytes;
  },
};

export const PuppeteerManager = {
  getInstance: () => manager,
  getOrCreate: () => manager,
};
