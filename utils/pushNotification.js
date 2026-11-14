import { logger } from './logger.js';
import DeviceToken from '../Models/DeviceToken.js';

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

let messaging = null;
let fcmInitialized = false;
let fcmInitError = null;
let initPromise = null;

const INVALID_TOKEN_CODES = [
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
];

/**
 * Parse FCM_SERVICE_ACCOUNT. Accepts raw JSON or base64-encoded JSON.
 */
function parseServiceAccount(raw) {
  const trimmed = raw.trim();
  const text = trimmed.startsWith('{')
    ? trimmed
    : Buffer.from(trimmed, 'base64').toString('utf8');
  return JSON.parse(text);
}

/**
 * Initialize Firebase Admin SDK for FCM.
 * Safe to call multiple times; retries if an earlier attempt failed.
 */
export async function initFCM() {
  if (fcmInitialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const raw = process.env.FCM_SERVICE_ACCOUNT;
      if (!raw) throw new Error('FCM_SERVICE_ACCOUNT not set');

      let serviceAccount;
      try {
        serviceAccount = parseServiceAccount(raw);
      } catch {
        throw new Error(
          'FCM_SERVICE_ACCOUNT must be valid JSON or base64-encoded JSON'
        );
      }

      if (
        !serviceAccount.project_id ||
        !serviceAccount.private_key ||
        !serviceAccount.client_email
      ) {
        throw new Error('Invalid Firebase service account credentials');
      }

      const projectId = process.env.FCM_PROJECT_ID || serviceAccount.project_id;
      if (projectId !== serviceAccount.project_id) {
        throw new Error('FCM_PROJECT_ID does not match service account project_id');
      }

      const existingApp = getApps().find((a) => a.name === 'maintenance-fcm');
      const app =
        existingApp ||
        initializeApp(
          {
            credential: cert({
              ...serviceAccount,
              private_key: serviceAccount.private_key.replace(/\\n/g, '\n'),
            }),
            projectId,
          },
          'maintenance-fcm'
        );

      messaging = getMessaging(app);
      fcmInitialized = true;
      fcmInitError = null;
      logger.info('FCM initialized successfully');
    } catch (err) {
      fcmInitError = err.message;
      messaging = null;
      fcmInitialized = false;
      logger.error({ err }, 'FCM initialization failed — push notifications disabled');
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

function isReady() {
  return messaging !== null && fcmInitialized && !fcmInitError;
}

/**
 * Make sure FCM is ready, retrying init if an earlier attempt failed.
 */
async function ensureReady() {
  if (!isReady()) await initFCM();
  return isReady();
}

function notReadyResult() {
  return {
    sent: 0,
    failed: 0,
    total: 0,
    error: fcmInitError || 'FCM not initialized',
  };
}

/** FCM data payload only supports string values. */
function formatData(data = {}) {
  return Object.fromEntries(
    Object.entries(data || {}).map(([key, value]) => [key, String(value)])
  );
}

function buildMessage(title, body, data = {}) {
  return {
    notification: { title, body },
    data: formatData(data),
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default' } } },
  };
}

/**
 * Send to a list of tokens in chunks of 500 (FCM limit).
 * Returns { sent, failed, total, invalidTokens }.
 */
async function sendInChunks(tokens, title, body, data) {
  const result = { sent: 0, failed: 0, total: tokens.length, invalidTokens: [] };

  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    const response = await messaging.sendEachForMulticast({
      ...buildMessage(title, body, data),
      tokens: chunk,
    });

    result.sent += response.successCount;
    result.failed += response.failureCount;

    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        const code = resp.error?.code;
        if (INVALID_TOKEN_CODES.includes(code)) {
          result.invalidTokens.push(chunk[idx]);
        } else {
          logger.warn({ code, message: resp.error?.message }, 'FCM send failure');
        }
      }
    });
  }

  return result;
}

/** Deactivate (not delete) tokens FCM says are invalid. */
async function deactivateTokens(tokens) {
  if (!tokens.length) return;
  await DeviceToken.updateMany(
    { deviceToken: { $in: tokens } },
    { $set: { isActive: false } }
  );
  logger.info({ invalidCount: tokens.length }, 'Deactivated invalid FCM tokens');
}

/**
 * Send a push notification to a single device token.
 */
export async function sendToDevice(token, title, body, data = {}) {
  if (!(await ensureReady())) return notReadyResult();

  try {
    const result = await sendInChunks([token], title, body, data);
    await deactivateTokens(result.invalidTokens);
    const { invalidTokens, ...rest } = result;
    return rest;
  } catch (err) {
    logger.error({ err }, 'Push sendToDevice failed');
    return { sent: 0, failed: 1, total: 1, error: err.message };
  }
}

/**
 * Send a push notification to all active devices of a user.
 */
export async function sendToUser(userId, title, body, data = {}) {
  if (!(await ensureReady())) return notReadyResult();

  try {
    const docs = await DeviceToken.find({ user: userId, isActive: true }).select(
      'deviceToken'
    );

    if (!docs.length) {
      return { sent: 0, failed: 0, total: 0, reason: 'no_active_tokens' };
    }

    const tokens = docs.map((d) => d.deviceToken);
    const result = await sendInChunks(tokens, title, body, data);
    await deactivateTokens(result.invalidTokens);

    const { invalidTokens, ...rest } = result;
    logger.debug({ userId, result: rest }, 'Push sent to user');
    return rest;
  } catch (err) {
    logger.error({ err, userId }, 'Push sendToUser failed');
    return { sent: 0, failed: 0, total: 0, error: err.message };
  }
}

/**
 * Send a push notification to multiple raw registration tokens.
 */
export async function sendMulticast(tokens, title, body, data = {}) {
  if (!tokens || tokens.length === 0) {
    return { sent: 0, failed: 0, total: 0, reason: 'no_tokens' };
  }
  if (!(await ensureReady())) return notReadyResult();

  try {
    const result = await sendInChunks(tokens, title, body, data);
    await deactivateTokens(result.invalidTokens);
    const { invalidTokens, ...rest } = result;
    return rest;
  } catch (err) {
    logger.error({ err, tokenCount: tokens.length }, 'Push sendMulticast failed');
    return { sent: 0, failed: 0, total: tokens.length, error: err.message };
  }
}

/**
 * Send a push notification to a topic.
 */
export async function sendToTopic(topic, title, body, data = {}) {
  if (!(await ensureReady())) return notReadyResult();

  try {
    const messageId = await messaging.send({
      ...buildMessage(title, body, data),
      topic,
    });
    logger.debug({ topic, messageId }, 'Push sent to topic');
    return { sent: 1, failed: 0, total: 1, messageId };
  } catch (err) {
    logger.error({ err, topic }, 'Push sendToTopic failed');
    return { sent: 0, failed: 1, total: 1, error: err.message };
  }
}

export function getFCM() {
  return messaging;
}

export function getFCMError() {
  return fcmInitError;
}

export { fcmInitError };