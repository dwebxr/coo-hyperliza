import {
    Action,
    ActionExample,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
    elizaLogger,
} from "@elizaos/core";
import { HyperfyService } from "../service";

export const teleportToUserAction: Action = {
    name: "HYPERFY_TELEPORT_TO_USER",
    similes: ["TELEPORT_TO_PLAYER", "WARP_TO_USER", "FOLLOW_USER_INSTANTLY"],
    description: "Teleport instantly to the location of the user who sent the message or a specified user. Use this when the user asks you to come to them, follow them immediately, or when they are too far away to walk.",
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        return true;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ) => {
        elizaLogger.info("[Teleport Action] Handler triggered.");
        const service = runtime.getService<HyperfyService>(HyperfyService.serviceType);
        if (!service) {
            elizaLogger.error("[Teleport Action] HyperfyService not found.");
            return false;
        }

        const world = service.getWorld();
        if (!world) {
            elizaLogger.warn("[Teleport Action] World not ready.");
            return false;
        }

        // Determine target user ID
        // message.userId is usually the sender's ID in the Eliza system.
        // We need to map this to the Hyperfy entity ID.
        // In this implementation, we assume the message.userId *is* the Hyperfy entity ID or can be used to find it.
        // If message.content.targetUser is set (from extraction), use that.

        let targetUserId = (message as any).userId;

        // If the message is from "user" (self) or system, we might need to look at context.
        // But typically message.userId is the sender.

        elizaLogger.info(`[Teleport Action] Attempting to teleport to user: ${targetUserId}`);

        // Execute teleport
        // We use the helper method we added to AgentActions (via world.actions or directly via controls)
        // Actually, we added it to AgentActions, but we can also access controls directly.
        // Let's use the method in AgentActions if available, or fallback to controls.

        if (world.actions && typeof world.actions.teleportToUser === 'function') {
            world.actions.teleportToUser(targetUserId);
        } else if (world.controls && typeof world.controls.teleportToEntity === 'function') {
            // Fallback direct control
            world.controls.teleportToEntity(targetUserId);
        } else {
            elizaLogger.error("[Teleport Action] Teleport capability not found on world.actions or world.controls.");
            return false;
        }

        if (callback) {
            callback({
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
