import { type IAgentRuntime, type Provider } from '@elizaos/core';
import { observedSession } from '../service';

/** How players can tip the agent; only while the world shows it as receiving tips. */
export function tipsGuidance(name: string): string {
  return [
    '# Tips (投げゼニ)',
    `Players can tip ${name} in JPYC: in the Players list, the Tip button next to ${name}. The payment goes from their own wallet; ${name} never sees or handles anyone's wallet.`,
    `Explain this only when someone asks how to tip or support ${name}. Never ask for tips or hint at them yourself.`,
  ].join('\n');
}

export const hyperfyTipsProvider: Provider = {
  name: 'HYPERFY_TIPS',
  description: 'Whether and how players can tip the agent',
  get: async (runtime: IAgentRuntime) => {
    // Values are not template-rendered, so the name is filled in here
    const text = observedSession(runtime)?.tipWallet?.receiving ? tipsGuidance(runtime.character.name) : '';
    return { text, values: { hyperfyTips: text } };
  },
};
