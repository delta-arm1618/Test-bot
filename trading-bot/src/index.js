'use strict';

/**
 * Entry Point — Trading Competition Bot
 * Bloc 4: adds monitoring init (Sentry), circuit breaker onStateChange hooks.
 * REPLACES: src/index.js
 */

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
const fs   = require('fs');
const path = require('path');

const { testConnection: testDB }    = require('../db/pool');
const { testConnection: testRedis } = require('./utils/redis');
const { registerSchedulers }        = require('./scheduler');
const { startHTTPServer }           = require('./http/server');
const { initSentry, reportCircuitBreakerChange } = require('./middleware/monitoring');
const { breakers }                  = require('./middleware/circuitBreaker');

// ── Sentry init (before anything else — captures startup errors too) ──
initSentry();

// ── Wire circuit breaker state-change → Discord alerts ────
for (const breaker of Object.values(breakers)) {
  breaker.onStateChange = reportCircuitBreakerChange;
}

// ── Discord Client ─────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

client.commands = new Collection();

// ── Load commands recursively ──────────────────────────────
function loadCommands(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
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

// ── Load event handlers ────────────────────────────────────
function loadEvents(dir) {
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const event = require(path.join(dir, file));
    const handler = (...args) => event.execute(...args, client);
    event.once ? client.once(event.name, handler) : client.on(event.name, handler);
    logger.debug(`Loaded event: ${event.name}`);
  }
}

// ── Boot Sequence ──────────────────────────────────────────
async function main() {
  try {
    logger.info('Connecting to PostgreSQL...');
    await testDB();

    logger.info('Connecting to Redis...');
    await testRedis();

    logger.info('Loading commands...');
    loadCommands(path.join(__dirname, 'commands'));
    logger.info(`Loaded ${client.commands.size} commands`);

    logger.info('Loading events...');
    loadEvents(path.join(__dirname, 'events'));

    // HTTP server (EA webhook + screenshots)
    startHTTPServer();

    logger.info('Connecting to Discord...');
    await client.login(config.discord.token);

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
