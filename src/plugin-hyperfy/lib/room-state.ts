import type { IAgentRuntime, UUID } from '@elizaos/core';

/**
 * The agent's state in an elizaOS room: a MUTED room is answered only when a message names the
 * agent by its character name. The one rule for the message handler
 * (handlers/messageReceivedHandler.ts) and for a stop taken on arrival
 * (session/connection-session.ts).
 */

/** Whether `text` names the agent by its character name (then a muted room answers it). */
export function namesAgent(runtime: Pick<IAgentRuntime, 'character'>, text: string | undefined | null): boolean {
  return !!text?.toLowerCase().includes(runtime.character.name.toLowerCase());
}

/** Whether a message `text` in `roomId` is ignored because the room is MUTED for the agent. */
export async function ignoredAsMuted(runtime: Pick<IAgentRuntime, 'character' | 'agentId' | 'getParticipantUserState'>, roomId: UUID, text: string | undefined | null): Promise<boolean> {
  if (namesAgent(runtime, text)) return false;
  // A runtime without room state (a stand-in) has no muted room
  if (typeof runtime.getParticipantUserState !== 'function') return false;
  return (await runtime.getParticipantUserState(roomId, runtime.agentId)) === 'MUTED';
}
