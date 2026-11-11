// Stands in for managers/puppeteer-manager in the sandbox child process: the agent downloads
// model bytes through Chromium, the child takes them from its own fake fetch instead.
const manager = {
  async loadGlbBytes(url: string): Promise<number[]> {
    const response = await fetch(url);
    return Array.from(new Uint8Array(await response.arrayBuffer()));
  },
  async loadVRMBytes(url: string): Promise<number[]> {
    return manager.loadGlbBytes(url);
  },
};

export const PuppeteerManager = {
  getInstance: () => manager,
  getOrCreate: () => manager,
};
