import 'ses';

import {
    type IAgentRuntime,
    type Memory,
    type Provider,
    type ProviderResult,
    logger,
    createUniqueUuid
} from '@elizaos/core';
import { HyperfyService } from '../service';
import * as THREE from 'three'
import { Vector3Enhanced } from '../hyperfy/src/core/extras/Vector3Enhanced.js'
import { SHOWN_NAME_MAX, oneLine, shownName, shownNames } from '../lib/text'
import { CHAT_BODY_MAX_CODE_POINTS } from '../lib/chat-intake'
import { HISTORY_TEXT_MAX_CODE_POINTS, PROMPT_ACTIONS_MAX, PROMPT_ACTION_NAME_MAX } from '../managers/message-manager'

// Per entity type, how many of the nearest entities get a full line. The rest are listed
// compactly (name + id) so actions can still target them without flooding the prompt.
const MAX_DETAILED_ENTITIES_PER_TYPE = 40;
// Names and labels come from the world (players, builders, app scripts): each enters the prompt as
// one short line without control or format characters. Players' names are cut like chat senders'.
const ENTITY_NAME_MAX = 64;
const promptName = (value: unknown, max = ENTITY_NAME_MAX) => shownName(value, max);
const promptId = (value: unknown) => shownName(String(value ?? ''), ENTITY_NAME_MAX) || 'unknown';

export const hyperfyProvider: Provider = {
    name: 'HYPERFY_WORLD_STATE',
    description: 'Provides current entity positions/rotations and agent state in the connected Hyperfy world.',
    get: async (runtime: IAgentRuntime, _message: Memory): Promise<ProviderResult> => {
      const currentDate = new Date();
      const timeOptions = {
        timeZone: 'UTC',
        dateStyle: 'full' as const,
        timeStyle: 'long' as const,
      };
      const utcTimeString = new Intl.DateTimeFormat('en-US', timeOptions).format(currentDate);

      const service = runtime.getService<HyperfyService>(HyperfyService.serviceType);

      if (!service || !service.isConnected()) {
        const text = '# Hyperfy World State\nConnection Status: Disconnected';
        return {
          text,
          values: { hyperfyStatus: text },
          data: { status: 'disconnected' },
        };
      }

      try {
        const world = service.getWorld();
        const messageManager = service.getMessageManager();
        const _currentWorldId = service.currentWorldId;
        const elizaRoomId = createUniqueUuid(runtime, _currentWorldId || 'hyperfy-unknown-world') 
        const entities = world?.entities?.items;
        const agentId = world?.entities?.player?.data?.id;

        const allEntityIds: string[] = [];
        const categorizedEntities: Record<string, { line: string; compact: string; distance: number }[]> = {};
        let agentText = '## Agent Info (You)\nUnable to find your own entity.';
        const nearbyPlayers: string[] = [];
        const agentPos = world?.entities?.player?.base?.position;

        for (const [id, entity] of entities.entries()) {
          const type = promptName(entity?.data?.type, 24) || 'unknown';
          const name = promptName(entity?.data?.name || entity?.blueprint?.name, type === 'player' ? SHOWN_NAME_MAX : ENTITY_NAME_MAX) || 'Unnamed';
          const pos = entity?.base?.position || entity?.root?.position;
          const quat = entity?.base?.quaternion || entity?.root?.quaternion;
          const scale = entity?.base?.scale || entity?.root?.scale;
          const posStr = pos && (pos instanceof THREE.Vector3 || pos instanceof Vector3Enhanced)
            ? `[${[pos.x, pos.y, pos.z].map(p => p.toFixed(2)).join(', ')}]`
            : 'N/A';
          
          const quatStr = quat && (quat instanceof THREE.Quaternion)
            ? `[${[quat.x, quat.y, quat.z, quat.w].map(q => q.toFixed(4)).join(', ')}]`
            : 'N/A';
      
          const scaleStr = scale && (scale instanceof THREE.Vector3 || scale instanceof Vector3Enhanced)
            ? `[${[scale.x, scale.y, scale.z].map(s => s.toFixed(2)).join(', ')}]`
            : 'N/A';

          const shownId = promptId(id);
          if (id === agentId) {
            agentText = `## Agent Info (You)\nEntity ID: ${shownId}, Name: ${name}, Position: ${posStr}, Quaternion: ${quatStr}`;
            continue;
          }

          allEntityIds.push(id);
          let line = `- Name: ${name}, Entity ID: ${shownId}, Position: ${posStr}, Quaternion: ${quatStr}`;

          if (type === 'app') {
            line += `, Scale: ${scaleStr}`;
          }

          // Track players separately for emphasis
          if (type === 'player') {
            nearbyPlayers.push(line);
          }

          if (!categorizedEntities[type]) {
            categorizedEntities[type] = [];
          }

          const distance = pos && agentPos && typeof pos.distanceTo === 'function'
            ? pos.distanceTo(agentPos)
            : Number.POSITIVE_INFINITY;
          categorizedEntities[type].push({ line, compact: `${name} (${shownId})`, distance });
        }

        let categorizedSummary = '';
        for (const [type, items] of Object.entries(categorizedEntities)) {
          items.sort((a, b) => a.distance - b.distance);
          const limit = type === 'player' ? items.length : MAX_DETAILED_ENTITIES_PER_TYPE;
          const detailed = items.slice(0, limit).map(item => item.line);
          const rest = items.slice(limit).map(item => item.compact);
          let section = `\n\n## ${type[0].toUpperCase() + type.slice(1)} Entities (${items.length})\n${detailed.join('\n')}`;
          if (rest.length > 0) {
            section += `\n- Farther away (${rest.length}, name and Entity ID only): ${rest.join(', ')}`;
          }
          categorizedSummary += section;
        }

        const actionsSystem = world?.actions;
        const nearbyActions = actionsSystem?.getNearby(50) || [];
        const currentAction = actionsSystem?.currentNode;

        const actionLines = nearbyActions.map(action => {
          const entity = action.ctx?.entity;
          const pos = entity?.root?.position;
          const posStr = (pos && (pos instanceof THREE.Vector3 || pos instanceof Vector3Enhanced))
            ? `[${[pos.x, pos.y, pos.z].map(p => p.toFixed(2)).join(', ')}]`
            : 'N/A';

          const label = promptName(action._label) || 'Unnamed Action';
          const entityId = promptId(entity?.data?.id);
          const entityName = promptName(entity?.blueprint?.name) || 'Unnamed';

          return `- Entity ID: ${entityId}, Entity Name: ${entityName}, Action: ${label}, Position: ${posStr}`;
        });

        const actionHeader = `## Nearby Interactable Objects (${actionLines.length})`;
        const actionBody = actionLines.length > 0
          ? actionLines.join('\n')
          : 'There are no interactable objects nearby.';
        const actionText = `${actionHeader}\n${actionBody}`;
        
        const equipText = currentAction ? (() => {
          const entity = currentAction.ctx?.entity;
          const label = promptName(currentAction._label) || 'Unnamed Action';
          const entityId = promptId(entity?.data?.id);
          const entityName = promptName(entity?.blueprint?.name) || 'Unnamed';
          return `## Your Equipped Item or Action\nYou are currently using:\n- Action: ${label}, Entity Name: ${entityName}, Entity ID: ${entityId}`;
        })() : '## Your Equipped Item or Action\nYou are not currently performing or holding anything.';


        const {
          formattedHistory,
          lastResponseText,
          lastActions
        } = await messageManager.getRecentMessages(elizaRoomId);

        let chatText = `## In-World Messages\n### Chat History\n${formattedHistory}`;

        // Bounded where it was received (chat intake, voice); bounded again here for any other source
        const messageText = oneLine(_message.content?.text ?? '', CHAT_BODY_MAX_CODE_POINTS);
        if (messageText) {
          const senderId = _message.entityId;
          const senderEntity = await runtime.getEntityById(senderId);
          const hyperfyMeta = senderEntity?.metadata?.hyperfy as { userName?: string; username?: string; name?: string } | undefined;
          const senderName = promptName(
            hyperfyMeta?.userName ||
            hyperfyMeta?.username ||
            hyperfyMeta?.name ||
            (senderEntity?.names || []).find(n => n.toLowerCase() !== 'anonymous'),
            SHOWN_NAME_MAX
          ) || 'Unknown User';

          const receivedMessageSection = [
            `### Received Message`,
            `${senderName}: ${messageText}`,
            `\n### Focus your response`,
            `You are replying to the above message from **${senderName}**. Keep your answer relevant to that message. Do not repeat earlier replies unless the sender asks again.`
          ].join('\n');

          chatText += `\n\n${receivedMessageSection}`;
        }

        // The agent's stored reply can quote world content (an entity's name, a player): one bounded
        // line, like a line of the history; its action names likewise
        const lastResponse = oneLine(typeof lastResponseText === 'string' ? lastResponseText : '', HISTORY_TEXT_MAX_CODE_POINTS);
        const lastActionText = JSON.stringify(shownNames(lastActions, PROMPT_ACTIONS_MAX, PROMPT_ACTION_NAME_MAX), null, 2);
        const agentMemoryText = lastResponse
          ? `### Your Last Response\n${lastResponse}\n\n_Do not repeat this unless someone asks again._\n\n### Your Last Action\n${lastActionText}`
          : `### Your Last Response\nNo recent message.\n\n### Your Last Action\n${lastActionText}`;

        // Emphasize nearby players for social interaction
        const playerSummary = nearbyPlayers.length > 0
          ? `## 🎮 Other Players in World (${nearbyPlayers.length})\n**There ${nearbyPlayers.length === 1 ? 'is' : 'are'} ${nearbyPlayers.length} other player${nearbyPlayers.length === 1 ? '' : 's'} nearby!** Be lively and dynamic — walk around, explore, interact with objects, greet players, or show expressions. Create an engaging presence through varied actions.\n${nearbyPlayers.join('\n')}`
          : `## 🎮 Other Players in World (0)\nYou are currently alone in the world. No need for autonomous behavior right now.`;

        const formattedText = [
          `# Hyperfy World State`,
          `\n## Current UTC Time\n${utcTimeString}`,
          `\n${playerSummary}`,
          `\n${agentText}`,
          `${categorizedSummary}`,
          `\n${actionText}`,
          `\n${equipText}`,
          `\n${chatText}`,
          `\n${agentMemoryText}`,
        ].join('\n');

        return {
          text: formattedText,
          values: { // Simplified values for quick access
            hyperfyStatus: formattedText,
          },
          data: {
          },
        };
      } catch (error: any) { // Add type annotation for error
         logger.error('Error getting Hyperfy state from service:', error);
         // The incoming message only reaches the prompt through this provider, so keep it on errors.
         const received = oneLine(_message.content?.text ?? '', CHAT_BODY_MAX_CODE_POINTS);
         const text = '# Hyperfy World State\nStatus: Error retrieving state.' +
           (received ? `\n\n### Received Message\n${received}` : '');
         return {
          text,
          values: { hyperfyStatus: text },
          data: { status: 'error', error: error.message },
        };
      }
    },
  };
