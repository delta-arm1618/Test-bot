'use strict';

// ── Load config first — fails fast on missing env vars ────
const config = require('../config');
const { logger } = require('./utils/logger');

logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
logger.info('  Trading Competition Bot  v1.0.0');
logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const { testConnection: testDB } = require('../db/pool');
const { testConnection: testRedis } = require('./utils/redis');
const { registerSchedulers } = require('./scheduler');
const { startHTTPServer } = require('./http/server');

// ── Discord Client ─────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,  // for season votes
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

// ── Command Collection ─────────────────────────────────────
client.commands = new Collection();

// Load all commands recursively from src/commands/
function loadCommands(dir) {
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      loadCommands(fullPath);
    } else if (item.name.endsWith('.js')) {
      try {
        const command = require(fullPath);
        if (command.data && command.execute) {
          client.commands.set(command.data.name, command);
          logger.debug(`Loaded command: /${command.data.name}`);
        }
      } catch (err) {
        logger.error(`Failed to load command ${fullPath}`, { error: err.message });
      }
    }
  }
}

// Load all event handlers from src/events/
function loadEvents(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  for (const file of files) {
    const event = require(path.join(dir, file));
    const handler = (...args) => event.execute(...args, client);
    if (event.once) {
      client.once(event.name, handler);
    } else {
      client.on(event.name, handler);
    }
    logger.debug(`Loaded event: ${event.name}`);
  }
}

// ── Boot Sequence ──────────────────────────────────────────
async function main() {
  try {
    // 1. Test DB connection
    logger.info('Connecting to PostgreSQL...');
    await testDB();

    // 2. Test Redis connection
    logger.info('Connecting to Redis...');
    await testRedis();

    // 3. Load commands
    logger.info('Loading commands...');
    loadCommands(path.join(__dirname, 'commands'));
    logger.info(`Loaded ${client.commands.size} commands`);

    // 4. Load events
    logger.info('Loading events...');
    loadEvents(path.join(__dirname, 'events'));

    // 5. Start HTTP server (EA webhook + screenshot uploads)
    startHTTPServer();

    // 6. Start Discord bot
    logger.info('Connecting to Discord...');
    await client.login(config.discord.token);

    // 7. Register cron schedulers (after login so guild is available)
    client.once('ready', () => {
      registerSchedulers(client);
    });

  } catch (err) {
    logger.error('Fatal startup error', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

// ── Graceful Shutdown ──────────────────────────────────────
process.on('SIGINT', async () => {
  logger.info('Shutting down gracefully...');
  client.destroy();
  const { pool } = require('../db/pool');
  const { redis } = require('./utils/redis');
  await pool.end();
  redis.disconnect();
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled promise rejection', { error: err?.message, stack: err?.stack });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

main();
