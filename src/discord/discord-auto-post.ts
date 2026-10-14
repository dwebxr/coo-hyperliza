import { IAgentRuntime, ModelType, logger } from '@elizaos/core';
import { Client, TextChannel, GatewayIntentBits } from 'discord.js';

/**
 * Discord Auto-Post Manager
 * Posts autonomous messages to Discord at configured intervals
 */
export class DiscordAutoPostManager {
  private runtime: IAgentRuntime;
  private client: Client | null = null;
  private postInterval: NodeJS.Timeout | null = null;
  private lastPostTime: number = 0;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  async start(): Promise<void> {
    const token = process.env.DISCORD_API_TOKEN;
    const channelId = process.env.DISCORD_POST_CHANNEL_ID;
    const enableAutoPost = process.env.DISCORD_ENABLE_AUTO_POST === 'true';
    const intervalHours = parseInt(process.env.DISCORD_POST_INTERVAL_HOURS || '24', 10);

    if (!token) {
      logger.warn('[DiscordAutoPost] No DISCORD_API_TOKEN found, skipping auto-post');
      return;
    }

    if (!enableAutoPost) {
      logger.info('[DiscordAutoPost] Auto-posting is disabled');
      return;
    }

    if (!channelId) {
      logger.warn('[DiscordAutoPost] No DISCORD_POST_CHANNEL_ID set, skipping auto-post');
      return;
    }

    logger.info(`[DiscordAutoPost] Starting with ${intervalHours}h interval to channel ${channelId}`);

    // Create Discord client
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
      ],
    });

    try {
      await this.client.login(token);
      logger.info('[DiscordAutoPost] Discord client logged in');

      // Wait for client to be ready
      await new Promise<void>((resolve) => {
        if (this.client!.isReady()) {
          resolve();
        } else {
          this.client!.once('ready', () => resolve());
        }
      });

      // Start the posting interval
      const intervalMs = intervalHours * 60 * 60 * 1000;

      // Post immediately on startup (optional - can be removed)
      // await this.postMessage(channelId);

      // Schedule periodic posts
      this.postInterval = setInterval(async () => {
        await this.postMessage(channelId);
      }, intervalMs);

      // Also do an initial post after a short delay (5 minutes after startup)
      setTimeout(async () => {
        const timeSinceLastPost = Date.now() - this.lastPostTime;
        if (timeSinceLastPost > intervalMs) {
          await this.postMessage(channelId);
        }
      }, 5 * 60 * 1000);

      logger.info('[DiscordAutoPost] Auto-post scheduler started');
    } catch (error) {
      logger.error('[DiscordAutoPost] Failed to start:', error);
    }
  }

  async stop(): Promise<void> {
    if (this.postInterval) {
      clearInterval(this.postInterval);
      this.postInterval = null;
    }
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    logger.info('[DiscordAutoPost] Stopped');
  }

  private async postMessage(channelId: string): Promise<void> {
    if (!this.client) return;

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !(channel instanceof TextChannel)) {
        logger.error('[DiscordAutoPost] Channel not found or not a text channel');
        return;
      }

      // Generate a post using the LLM
      const content = await this.generatePost();
      if (!content) {
        logger.warn('[DiscordAutoPost] Failed to generate post content');
        return;
      }

      await channel.send(content);
      this.lastPostTime = Date.now();
      logger.info(`[DiscordAutoPost] Posted: ${content.substring(0, 50)}...`);
    } catch (error) {
      logger.error('[DiscordAutoPost] Failed to post message:', error);
    }
  }

  private async generatePost(): Promise<string | null> {
    try {
      const prompt = `You are Coo, a friendly AI agent. Generate a short, engaging message to post on Discord.
The message should be:
- Friendly and conversational
- About 1-3 sentences
- Can be a greeting, an interesting thought, a question to the community, or sharing what you're up to
- Sometimes in English, sometimes in Japanese (mix it up)
- NOT include any hashtags or promotional content

Examples of good posts:
- "Good morning everyone! Hope you're all having a great day. What's everyone working on today?"
- "おはよう！今日も元気にやっていきましょう〜"
- "Just been exploring some new virtual worlds. The creativity out there is amazing!"
- "Anyone else love the feeling of discovering something new? What have you discovered lately?"

Generate a single post message now:`;

      const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      // Clean up the response
      let content = response.trim();

      // Remove quotes if present
      if ((content.startsWith('"') && content.endsWith('"')) ||
          (content.startsWith("'") && content.endsWith("'"))) {
        content = content.slice(1, -1);
      }

      return content || null;
    } catch (error) {
      logger.error('[DiscordAutoPost] Failed to generate post:', error);
      return null;
    }
  }
}
