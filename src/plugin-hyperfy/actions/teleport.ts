import {
    Action,
    ActionExample,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
    logger,
} from "@elizaos/core";
import { HyperfyService } from "../service";

export const teleportToUserAction: Action = {
    name: "HYPERFY_TELEPORT_TO_USER",
    similes: ["TELEPORT_TO_PLAYER", "WARP_TO_USER", "FOLLOW_USER_INSTANTLY"],
    description: "Teleport instantly to the location of the user who sent the message or a specified user. Use this when the user asks you to come to them, follow them immediately, or when they are too far away to walk.",
    validate: async (runtime: IAgentRuntime) => {
        const service = runtime.getService<HyperfyService>(HyperfyService.serviceType);
        return !!service && service.isConnected();
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ) => {
        logger.info("[Teleport Action] Handler triggered.");
        const service = runtime.getService<HyperfyService>(HyperfyService.serviceType);
        if (!service) {
            logger.error("[Teleport Action] HyperfyService not found.");
            return false;
        }

        const world = service.getWorld();
        if (!world) {
            logger.warn("[Teleport Action] World not ready.");
            return false;
        }

        // Hyperfy entity id of the chat sender; absent for autonomous runs, in which case
        // AgentActions.teleportToUser falls back to the nearest other player.
        const targetUserId = (message.content?.metadata as { hyperfyFromId?: string } | undefined)?.hyperfyFromId;

        logger.info(`[Teleport Action] Attempting to teleport to user: ${targetUserId ?? "(nearest player)"}`);

        if (world.actions && typeof world.actions.teleportToUser === 'function') {
            world.actions.teleportToUser(targetUserId);
        } else if (world.controls && typeof world.controls.teleportToEntity === 'function') {
            // Fallback direct control
            world.controls.teleportToEntity(targetUserId);
        } else {
            logger.error("[Teleport Action] Teleport capability not found on world.actions or world.controls.");
            return false;
        }

        if (callback) {
            await callback({
                text: `Teleporting to you!`,
                actions: ["HYPERFY_TELEPORT_TO_USER"],
                source: "hyperfy",
            });
        }

        return;
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Come here!",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "On my way! *teleports*",
                    action: "HYPERFY_TELEPORT_TO_USER",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Teleport to me.",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Warping to your location now!",
                    action: "HYPERFY_TELEPORT_TO_USER",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "I'm at the spawn point, come find me.",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Okay, I'll teleport there immediately.",
                    action: "HYPERFY_TELEPORT_TO_USER",
                },
            },
        ],
    ] as ActionExample[][],
};
