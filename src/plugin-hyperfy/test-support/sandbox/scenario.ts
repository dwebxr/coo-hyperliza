/** What one run of the sandbox child process (child.ts) is asked to do */
export interface Scenario {
  /**
   * 'engine-compartment' is not a mode of the agent: it locks the realm down and then evaluates the
   * script the way the engine itself does (world.scripts.evaluate, no membrane), to show what the
   * membrane is there for.
   */
  mode: 'off' | 'sandboxed' | 'engine-compartment';
  /** The app script's source */
  script: string;
  /** Give scripts a network function that answers every URL with these bytes (as text) */
  networkBody?: string;
  /**
   * Give scripts the real network function (lib/script-network.ts) over the real policy, in a
   * made-up internet: https://api.test is a public API (a server in the child stands in for it),
   * internal.test resolves to a private address. `%WORLD%` in the script becomes the world's origin.
   */
  policyNetwork?: boolean;
  /** Leave the engine's own Chat.add in place instead of the agent's (lib/world-chat.ts) */
  engineChat?: boolean;
  /** Have the agent use the nearest action node, then release it */
  useItem?: boolean;
  /** Wait (up to 10 s) until the script has sent this app event */
  waitForEvent?: string;
  /** Absolute path of physx/loadPhysX.js: load real PhysX and let the engine extend three.js with it */
  physxModule?: string;
}
