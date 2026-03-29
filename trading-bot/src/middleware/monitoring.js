'use strict';

/**
 * Monitoring — Sentry + Discord Alert Integration
 * Sends critical errors to Sentry DSN and posts alerts to Discord.
 */

const { createLogger } = require('../utils/logger');
const config = require('../../config');

const log = createLogger('Monitoring');

// ── Sentry Setup ──────────────────────────────────────────
let Sentry = null;

function initSentry() {
  if (!config.logging.sentryDsn) {
    log.info('Sentry DSN not set — error tracking disabled');
    return;
  }

  try {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn: config.logging.sentryDsn,
      environment: config.env,
      tracesSampleRate: config.isProd ? 0.1 : 0.0,
      beforeSend(event) {
        // Scrub sensitive fields before sending
        if (event.extra) {
          delete event.extra.credentials;
          delete event.extra.token;
          delete event.extra.aesKey;
        }
        return event;
      },
    });
    log.info('Sentry initialized successfully');
  } catch (err) {
    log.warn('Sentry unavailable — install @sentry/node to enable', { error: err.message });
  }
}

/**
 * Capture an exception (Sentry + logger fallback).
 * @param {Error} err
 * @param {Object} [context]
 */
function captureException(err, context = {}) {
  log.error('Exception captured', { error: err.message, stack: err.stack, ...context });

  if (Sentry) {
    Sentry.withScope(scope => {
      scope.setExtras(context);
      Sentry.captureException(err);
    });
  }
}

/**
 * Capture a non-fatal warning message.
 * @param {string} message
 * @param {'warning'|'info'|'error'} level
 * @param {Object} [context]
 */
function captureMessage(message, level = 'warning', context = {}) {
  log.warn(message, context);

  if (Sentry) {
    Sentry.withScope(scope => {
      scope.setLevel(level);
      scope.setExtras(context);
      Sentry.captureMessage(message);
    });
  }
}

// ── Discord Alert Channel ─────────────────────────────────
let _discordClient = null;

/** Register the Discord client so alerts can be posted. */
function setDiscordClient(client) {
  _discordClient = client;
}

/**
 * Post an embed alert to the announcements channel.
 * @param {string} title
 * @param {string} description
 * @param {'error'|'warning'|'info'} level
 */
async function sendDiscordAlert(title, description, level = 'error') {
  if (!_discordClient) return;

  const channelId = config.discord.channels.announcements;
  if (!channelId) return;

  const colors = { error: 0xED4245, warning: 0xFEE75C, info: 0x00B0F4 };
  const icons  = { error: '🚨',     warning: '⚠️',     info: 'ℹ️'    };

  try {
    const channel = _discordClient.channels.cache.get(channelId);
    if (!channel) return;

    await channel.send({
      embeds: [{
        color: colors[level] ?? colors.error,
        title: `${icons[level]} ${title}`,
        description,
        footer: { text: `Trading Competition Bot • ${level.toUpperCase()}` },
        timestamp: new Date().toISOString(),
      }],
    });
  } catch (err) {
    // Never let a monitoring failure crash the bot
    log.error('Failed to send Discord alert', { error: err.message });
  }
}

/**
 * Report a cron job failure — called from scheduler.js catch blocks.
 * @param {string} jobName
 * @param {Error} err
 */
async function reportCronFailure(jobName, err) {
  captureException(err, { job: jobName });
  await sendDiscordAlert(
    `Cron Failure: ${jobName}`,
    `The scheduled job **${jobName}** failed:\n\`\`\`${err.message}\`\`\``,
    'error'
  );
}

/**
 * Report a circuit breaker state change.
 * Hooked into CircuitBreaker.onStateChange.
 * @param {string} from — previous state
 * @param {string} to   — new state
 * @param {string} name — service name
 */
async function reportCircuitBreakerChange(from, to, name) {
  if (to === 'OPEN') {
    await sendDiscordAlert(
      `Circuit Breaker OPEN: ${name}`,
      `The **${name}** API is down. Broker polling is paused. Will auto-retry in 60s.`,
      'error'
    );
  } else if (to === 'CLOSED' && from !== 'CLOSED') {
    await sendDiscordAlert(
      `Circuit Breaker RECOVERED: ${name}`,
      `The **${name}** API connection has recovered. Polling is resumed.`,
      'info'
    );
  }
}

module.exports = {
  initSentry,
  captureException,
  captureMessage,
  setDiscordClient,
  sendDiscordAlert,
  reportCronFailure,
  reportCircuitBreakerChange,
};
