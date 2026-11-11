import {
    Action,
    IAgentRuntime,
    logger,
} from "@elizaos/core";
import { actingSession, connectedSession } from "../service";
import { TurnCancelled } from "../lib/turn-context";
import { actionFailed, actionSucceeded, tellFailure } from "../lib/action-result";

const TELEPORT_TO_USER = "HYPERFY_TELEPORT_TO_USER";

export const teleportToUserAction: Action = {
    name: TELEPORT_TO_USER,
    similes: ["TELEPORT_TO_PLAYER", "WARP_TO_USER", "FOLLOW_USER_INSTANTLY"],
    description: "Teleport instantly to the location of the user who sent the message or a specified user. Use this when the user asks you to come to them, follow them immediately, or when they are too far away to walk.",
    validate: async (runtime: IAgentRuntime) => {
        return !!connectedSession(runtime);
    },
    handler: async (runtime, message, _state, _options, callback) => {
        logger.info("[Teleport Action] Handler triggered.");
        // The turn's own connection (never a newer one); throws when the turn may no longer act
        const session = actingSession(runtime);
        const world = session?.world;
        if (!session || !world) {
            logger.warn("[Teleport Action] World not ready.");
            await tellFailure(callback, TELEPORT_TO_USER, "I can't teleport right now.");
            return actionFailed(TELEPORT_TO_USER, "world not ready");
        }

        // Hyperfy entity id of the chat sender; absent for autonomous runs, in which case
        // AgentActions.teleportToUser falls back to the nearest other player.
        const targetUserId = (message.content?.metadata as { hyperfyFromId?: string } | undefined)?.hyperfyFromId;

        logger.info(`[Teleport Action] Attempting to teleport to user: ${targetUserId ?? "(nearest player)"}`);

        // 'arrived' only when the agent was moved (systems/controls.ts MoveOutcome)
        let teleported: boolean;
        try {
            if (world.actions && typeof world.actions.teleportToUser === 'function') {
                // Moves the avatar: one such section at a time (ConnectionSession.withBody)
                teleported = await session.withBody(async () => world.actions.teleportToUser(targetUserId) === 'arrived');
            } else if (world.controls && typeof world.controls.teleportToEntity === 'function') {
                // Fallback direct control
                teleported = await session.withBody(async () => world.controls.teleportToEntity(targetUserId) === 'arrived');
            } else {
                logger.error("[Teleport Action] Teleport capability not found on world.actions or world.controls.");
                await tellFailure(callback, TELEPORT_TO_USER, "I can't teleport right now.");
                return actionFailed(TELEPORT_TO_USER, "teleport capability not found");
            }
        } catch (error: any) {
            if (error instanceof TurnCancelled) throw error;
            logger.error("[Teleport Action] Teleport failed:", error);
            await tellFailure(callback, TELEPORT_TO_USER, "I couldn't teleport just now.");
            return actionFailed(TELEPORT_TO_USER, `teleport failed: ${error?.message ?? error}`);
        }
        if (!teleported) {
            logger.warn("[Teleport Action] No player to teleport to; nothing happened.");
            await tellFailure(callback, TELEPORT_TO_USER, "I couldn't find anyone to teleport to.");
            return actionFailed(TELEPORT_TO_USER, "no player to teleport to");
        }

        if (callback) {
            await callback({
                text: `Teleporting to you!`,
                actions: [TELEPORT_TO_USER],
                source: "hyperfy",
            });
        }

        return actionSucceeded(TELEPORT_TO_USER);
    },
    examples: [
        [
            {
                name: "{{name1}}",
                content: {
                    text: "Come here!",
                },
            },
            {
                name: "{{name2}}",
                content: {
                    text: "On my way! *teleports*",
                    actions: ["HYPERFY_TELEPORT_TO_USER"],
                },
            },
        ],
        [
            {
                name: "{{name1}}",
                content: {
                    text: "Teleport to me.",
                },
            },
            {
                name: "{{name2}}",
                content: {
                    text: "Warping to your location now!",
                    actions: ["HYPERFY_TELEPORT_TO_USER"],
                },
            },
        ],
        [
            {
                name: "{{name1}}",
                content: {
                    text: "I'm at the spawn point, come find me.",
                },
            },
            {
                name: "{{name2}}",
                content: {
                    text: "Okay, I'll teleport there immediately.",
                    actions: ["HYPERFY_TELEPORT_TO_USER"],
                },
            },
        ],
    ],
};
