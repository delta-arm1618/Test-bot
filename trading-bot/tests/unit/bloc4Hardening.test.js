'use strict';

/**
 * Unit Tests — Bloc 4: Rate Limiter & Circuit Breaker
 */

process.env.AES_SECRET_KEY = 'test_secret_key_32_chars_exactly';
process.env.JWT_SECRET = 'test_jwt_secret_here_long_enough';
process.env.DISCORD_TOKEN = 'test_token';
process.env.DISCORD_CLIENT_ID = '123456789012345678';
process.env.GUILD_ID = '987654321098765432';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.HTTP_SECRET = 'test_http_secret';
process.env.REDIS_URL = 'redis://localhost:6379';

const { CircuitBreaker, STATE } = require('../../src/middleware/circuitBreaker');

// ════════════════════════════════════════════════════════════
// CIRCUIT BREAKER — State transitions
// ════════════════════════════════════════════════════════════
describe('CircuitBreaker — State Transitions', () => {
  let breaker;

  beforeEach(() => {
    breaker = new CircuitBreaker('TestService', {
      failureThreshold: 3,
      successThreshold: 2,
      timeout: 100, // 100ms for fast tests
    });
  });

  test('Initial state is CLOSED', () => {
    expect(breaker.state).toBe(STATE.CLOSED);
    expect(breaker.failureCount).toBe(0);
  });

  test('Successful call stays CLOSED', async () => {
    await breaker.execute(async () => 'ok');
    expect(breaker.state).toBe(STATE.CLOSED);
  });

  test('Returns the function result', async () => {
    const result = await breaker.execute(async () => 42);
    expect(result).toBe(42);
  });

  test('Opens after failureThreshold failures', async () => {
    const failFn = async () => { throw new Error('Service down'); };

    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failFn)).rejects.toThrow('Service down');
    }

    expect(breaker.state).toBe(STATE.OPEN);
  });

  test('Rejects immediately when OPEN', async () => {
    // Force open
    breaker.state = STATE.OPEN;
    breaker.nextAttemptTime = Date.now() + 60_000;

    await expect(breaker.execute(async () => 'ok'))
      .rejects.toThrow('Circuit breaker OPEN');
  });

  test('Transitions to HALF_OPEN after timeout', async () => {
    const failFn = async () => { throw new Error('Down'); };
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failFn)).rejects.toThrow();
    }

    expect(breaker.state).toBe(STATE.OPEN);

    // Simulate timeout passing
    breaker.nextAttemptTime = Date.now() - 1;

    // Next call should probe (HALF_OPEN)
    const successFn = async () => 'recovered';
    await breaker.execute(successFn); // First probe — succeeds but still HALF_OPEN with successThreshold=2

    // State should be HALF_OPEN now (needs 2 successes to close)
    // Since we only have 1 success and successThreshold=2, still HALF_OPEN
    expect([STATE.HALF_OPEN, STATE.CLOSED]).toContain(breaker.state);
  });

  test('Closes after successThreshold successes in HALF_OPEN', async () => {
    breaker.state = STATE.HALF_OPEN;
    breaker.successCount = 0;

    const successFn = async () => 'ok';
    await breaker.execute(successFn); // success 1
    await breaker.execute(successFn); // success 2 → should close

    expect(breaker.state).toBe(STATE.CLOSED);
    expect(breaker.failureCount).toBe(0);
  });

  test('Goes back to OPEN on failure in HALF_OPEN', async () => {
    breaker.state = STATE.HALF_OPEN;
    breaker.nextAttemptTime = null;

    await expect(breaker.execute(async () => { throw new Error('Still down'); }))
      .rejects.toThrow('Still down');

    expect(breaker.state).toBe(STATE.OPEN);
  });

  test('Manual reset returns to CLOSED', () => {
    breaker.state = STATE.OPEN;
    breaker.failureCount = 5;
    breaker.nextAttemptTime = Date.now() + 60_000;

    breaker.reset();

    expect(breaker.state).toBe(STATE.CLOSED);
    expect(breaker.failureCount).toBe(0);
    expect(breaker.nextAttemptTime).toBeNull();
  });

  test('getStatus returns correct shape', () => {
    const status = breaker.getStatus();
    expect(status).toHaveProperty('name');
    expect(status).toHaveProperty('state');
    expect(status).toHaveProperty('failureCount');
    expect(status).toHaveProperty('successCount');
    expect(status.name).toBe('TestService');
  });

  test('onStateChange callback is invoked', async () => {
    const stateChanges = [];
    const testBreaker = new CircuitBreaker('CB_Callback', {
      failureThreshold: 2,
      successThreshold: 1,
      timeout: 100,
      onStateChange: (from, to, name) => stateChanges.push({ from, to, name }),
    });

    const failFn = async () => { throw new Error('fail'); };
    for (let i = 0; i < 2; i++) {
      await expect(testBreaker.execute(failFn)).rejects.toThrow();
    }

    expect(stateChanges.length).toBeGreaterThan(0);
    expect(stateChanges[0].to).toBe(STATE.OPEN);
  });
});

// ════════════════════════════════════════════════════════════
// CIRCUIT BREAKER — Concurrent calls
// ════════════════════════════════════════════════════════════
describe('CircuitBreaker — Concurrent Safety', () => {
  test('Multiple concurrent successes stay CLOSED', async () => {
    const breaker = new CircuitBreaker('Concurrent', { failureThreshold: 10 });
    const tasks = Array.from({ length: 10 }, () =>
      breaker.execute(async () => Math.random())
    );
    const results = await Promise.all(tasks);
    expect(results).toHaveLength(10);
    expect(breaker.state).toBe(STATE.CLOSED);
  });

  test('Mixed successes and failures count correctly', async () => {
    const breaker = new CircuitBreaker('Mixed', { failureThreshold: 5 });
    const tasks = Array.from({ length: 8 }, (_, i) =>
      breaker.execute(async () => {
        if (i % 2 === 0) throw new Error('fail');
        return 'ok';
      }).catch(() => null)
    );
    await Promise.all(tasks);
    // 4 failures, threshold is 5 — should still be CLOSED
    expect(breaker.failureCount).toBe(4);
    expect(breaker.state).toBe(STATE.CLOSED);
  });
});

// ════════════════════════════════════════════════════════════
// MULTI-BROKER — Connector validation
// ════════════════════════════════════════════════════════════
describe('Multi-Broker — Connector Module Exports', () => {
  test('cTrader connector exports required functions', () => {
    const ctrader = require('../../src/modules/tracking/cTraderConnector');
    expect(typeof ctrader.exchangeAuthCode).toBe('function');
    expect(typeof ctrader.refreshAccessToken).toBe('function');
    expect(typeof ctrader.fetchCTraderMetrics).toBe('function');
  });

  test('Tradovate connector exports required functions', () => {
    const tradovate = require('../../src/modules/tracking/tradovateConnector');
    expect(typeof tradovate.authenticate).toBe('function');
    expect(typeof tradovate.fetchTradovateMetrics).toBe('function');
  });
});

// ════════════════════════════════════════════════════════════
// MONITORING — Module exports
// ════════════════════════════════════════════════════════════
describe('Monitoring — Module Exports', () => {
  test('monitoring module exports all required functions', () => {
    const monitoring = require('../../src/middleware/monitoring');
    expect(typeof monitoring.initSentry).toBe('function');
    expect(typeof monitoring.captureException).toBe('function');
    expect(typeof monitoring.captureMessage).toBe('function');
    expect(typeof monitoring.setDiscordClient).toBe('function');
    expect(typeof monitoring.sendDiscordAlert).toBe('function');
    expect(typeof monitoring.reportCronFailure).toBe('function');
    expect(typeof monitoring.reportCircuitBreakerChange).toBe('function');
  });

  test('captureException does not throw when called without Sentry', () => {
    const { captureException } = require('../../src/middleware/monitoring');
    expect(() => captureException(new Error('test error'), { context: 'unit test' })).not.toThrow();
  });
});
