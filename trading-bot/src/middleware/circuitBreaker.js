'use strict';

/**
 * Circuit Breaker
 * Prevents cascading failures when external APIs (MetaApi, cTrader) are down.
 *
 * States:
 *  CLOSED   — Normal operation. Requests pass through.
 *  OPEN     — Too many failures. Requests are rejected immediately.
 *  HALF_OPEN — Testing if the service has recovered.
 */

const { createLogger } = require('../utils/logger');

const log = createLogger('CircuitBreaker');

const STATE = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
};

class CircuitBreaker {
  /**
   * @param {string} name           - Identifier for logs
   * @param {Object} [opts]
   * @param {number} [opts.failureThreshold=5]   - Failures before OPEN
   * @param {number} [opts.successThreshold=2]   - Successes in HALF_OPEN to close
   * @param {number} [opts.timeout=30000]        - ms to wait before HALF_OPEN
   * @param {Function} [opts.onStateChange]      - Called with (from, to, name)
   */
  constructor(name, opts = {}) {
    this.name = name;
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.successThreshold = opts.successThreshold ?? 2;
    this.timeout = opts.timeout ?? 30_000;
    this.onStateChange = opts.onStateChange ?? null;

    this.state = STATE.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.nextAttemptTime = null;
  }

  /**
   * Execute a function through the circuit breaker.
   *
   * @param {Function} fn - async function to wrap
   * @returns {*} Result of fn
   * @throws Circuit open error or fn's error
   */
  async execute(fn) {
    if (this.state === STATE.OPEN) {
      if (Date.now() < this.nextAttemptTime) {
        const waitMs = this.nextAttemptTime - Date.now();
        throw new Error(`Circuit breaker OPEN for "${this.name}". Retry in ${Math.ceil(waitMs / 1000)}s.`);
      }
      // Transition to HALF_OPEN for a probe attempt
      this._transitionTo(STATE.HALF_OPEN);
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure(err);
      throw err;
    }
  }

  _onSuccess() {
    if (this.state === STATE.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this._transitionTo(STATE.CLOSED);
      }
    } else {
      this.failureCount = 0;
    }
  }

  _onFailure(err) {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    log.warn(`Circuit breaker failure`, {
      name: this.name,
      count: this.failureCount,
      threshold: this.failureThreshold,
      error: err.message,
    });

    if (this.state === STATE.HALF_OPEN || this.failureCount >= this.failureThreshold) {
      this._transitionTo(STATE.OPEN);
    }
  }

  _transitionTo(newState) {
    const prev = this.state;
    this.state = newState;

    if (newState === STATE.OPEN) {
      this.nextAttemptTime = Date.now() + this.timeout;
      this.successCount = 0;
      log.error(`Circuit breaker OPENED for "${this.name}". Will retry in ${this.timeout / 1000}s.`);
    } else if (newState === STATE.CLOSED) {
      this.failureCount = 0;
      this.successCount = 0;
      log.info(`Circuit breaker CLOSED for "${this.name}" — service recovered.`);
    } else if (newState === STATE.HALF_OPEN) {
      log.info(`Circuit breaker HALF_OPEN for "${this.name}" — probing service.`);
    }

    if (this.onStateChange) {
      this.onStateChange(prev, newState, this.name);
    }
  }

  /**
   * Get current status (useful for health checks / admin commands).
   */
  getStatus() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      nextAttemptTime: this.nextAttemptTime,
    };
  }

  /**
   * Manually reset (admin use).
   */
  reset() {
    const prev = this.state;
    this.state = STATE.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.nextAttemptTime = null;
    log.info(`Circuit breaker manually reset for "${this.name}"`);
    if (this.onStateChange) this.onStateChange(prev, STATE.CLOSED, this.name);
  }
}

// ── Singleton breakers per service ────────────────────────
const breakers = {
  metaapi: new CircuitBreaker('MetaApi', {
    failureThreshold: 5,
    successThreshold: 2,
    timeout: 60_000, // 1 minute before retry
  }),
  ctrader: new CircuitBreaker('cTrader', {
    failureThreshold: 3,
    successThreshold: 2,
    timeout: 30_000,
  }),
  tradovate: new CircuitBreaker('Tradovate', {
    failureThreshold: 3,
    successThreshold: 2,
    timeout: 30_000,
  }),
};

/**
 * Wrap a MetaApi call with the circuit breaker.
 */
async function withMetaApi(fn) {
  return breakers.metaapi.execute(fn);
}

/**
 * Get all circuit breaker statuses.
 */
function getAllStatuses() {
  return Object.values(breakers).map(b => b.getStatus());
}

/**
 * Reset a circuit breaker by name.
 */
function resetBreaker(name) {
  const breaker = breakers[name.toLowerCase()];
  if (!breaker) throw new Error(`Unknown circuit breaker: ${name}`);
  breaker.reset();
}

module.exports = {
  CircuitBreaker,
  breakers,
  withMetaApi,
  getAllStatuses,
  resetBreaker,
  STATE,
};
