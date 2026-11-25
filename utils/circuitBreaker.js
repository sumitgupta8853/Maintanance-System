/**
 * Simple in-memory circuit breaker.
 *
 * States:
 *  - CLOSED: requests flow through normally.
 *  - OPEN: requests are short-circuited (fail fast).
 *  - HALF_OPEN: a trial request is allowed to test recovery.
 *
 * @param {string} name - Breaker identifier (for logging / multi-breaker support)
 * @param {object} options
 * @param {number} options.threshold - Failures within windowMs to trip the breaker
 * @param {number} options.cooldownMs - Time to wait in OPEN before trying HALF_OPEN
 * @param {number} options.windowMs - Sliding window for failure counting
 * @param {number} options.halfOpenMax - Max trial calls in HALF_OPEN before re-tripping
 */
export const createCircuitBreaker = (name, {
  threshold = 5,
  cooldownMs = 60000,
  windowMs = 300000,
  halfOpenMax = 1,
} = {}) => {
  let state = 'CLOSED'; // CLOSED | OPEN | HALF_OPEN
  let failures = [];    // timestamps of failures within windowMs
  let openedAt = null;  // timestamp when breaker entered OPEN
  let halfOpenCalls = 0;

  const now = () => Date.now();

  const prune = () => {
    const cutoff = now() - windowMs;
    failures = failures.filter((t) => t > cutoff);
  };

  return {
    name,
    state: () => state,

    /** Check if the breaker is OPEN (requests should be short-circuited) */
    isOpen: async () => {
      prune();
      if (state === 'OPEN') {
        if (now() - openedAt >= cooldownMs) {
          state = 'HALF_OPEN';
          halfOpenCalls = 0;
          return false; // allow trial
        }
        return true;
      }
      return false;
    },

    /** Record a successful call */
    recordSuccess: async () => {
      if (state === 'HALF_OPEN') {
        state = 'CLOSED';
        failures = [];
        halfOpenCalls = 0;
      }
    },

    /** Record a failed call */
    recordFailure: async () => {
      failures.push(now());
      prune();

      if (state === 'HALF_OPEN') {
        state = 'OPEN';
        openedAt = now();
        halfOpenCalls = 0;
        return;
      }

      if (failures.length >= threshold) {
        state = 'OPEN';
        openedAt = now();
      }
    },
  };
};

const breakers = new Map();

/**
 * Get (or create) a named circuit breaker.
 */
export const forName = (name, options) => {
  if (!breakers.has(name)) {
    breakers.set(name, createCircuitBreaker(name, options));
  }
  return breakers.get(name);
};
