
import { logger } from './logger.js';
import DeviceToken from '../Models/DeviceToken.js';

import {
  initializeApp,
  cert,
  getApps,
} from 'firebase-admin/app';

import {
  getMessaging,
} from 'firebase-admin/messaging';

let messaging = null;
let fcmInitialized = false;
let fcmInitError = null;

/**
 * Initialize Firebase Admin SDK for FCM.
 * Reads FCM_SERVICE_ACCOUNT (JSON string) from env.
 * Fails gracefully: push is best-effort and never breaks request flow.
 */
export async function initFCM() {
  if (fcmInitialized) return;

  try {
    const serviceAccountRaw = process.env.FCM_SERVICE_ACCOUNT;

    if (!serviceAccountRaw) {
      throw new Error('FCM_SERVICE_ACCOUNT not set');
    }

    let serviceAccount;

    try {
      serviceAccount = JSON.parse(serviceAccountRaw);
    } catch {
      throw new Error(
        'FCM_SERVICE_ACCOUNT must contain valid JSON service account credentials'
      );
    }

    if (
      !serviceAccount.project_id ||
      !serviceAccount.private_key ||
      !serviceAccount.client_email
    ) {
      throw new Error('Invalid Firebase service account credentials');
    }

    const projectId =
      process.env.FCM_PROJECT_ID || serviceAccount.project_id;

    if (projectId !== serviceAccount.project_id) {
      throw new Error(
        'FCM_PROJECT_ID does not match service account project_id'
      );
    }

    const existingApp = getApps().find(
      (app) => app.name === 'maintenance-fcm'
    );

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

    logger.error(
      { err },
      'FCM initialization failed — push notifications disabled'
    );
  }
}

/**
 * Check whether FCM is ready.
 */
function isReady() {
  return (
    messaging !== null &&
    fcmInitialized &&
    !fcmInitError
  );
}

/**
 * Convert custom data values to strings.
 * FCM data payload only supports string values.
 */
function formatData(data = {}) {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      String(value),
    ])
  );
}

/**
 * Common notification payload.
 */
function buildMessage(title, body, data = {}) {
  return {
    notification: {
      title,
      body,
    },
    data: formatData(data),
    android: {
      priority: 'high',
    },
    apns: {
      payload: {
        aps: {
          sound: 'default',
        },
      },
    },
  };
}

/**
 * Send a push notification to a single device.
 */
export async function sendToDevice(
  token,
  title,
  body,
  data = {}
) {
  if (!isReady()) {
    logger.debug(
      `Push skipped (FCM not ready): ${title}`
    );
    return null;
  }

  try {
    const message = {
      ...buildMessage(title, body, data),
      token,
    };

    const response = await messaging.send(message);

    logger.debug(
      { response },
      'Push sent to device'
    );

    return response;
  } catch (err) {
    logger.error(
      { err },
      'Push sendToDevice failed'
    );

    return null;
  }
}

/**
 * Send a push notification to all active devices of a user.
 */
export async function sendToUser(
  userId,
  title,
  body,
  data = {}
) {
  const result = {
    sent: 0,
    failed: 0,
    total: 0,
  };

  if (!isReady()) return result;

  try {
    const tokens = await DeviceToken.find({
      user: userId,
      isActive: true,
    }).select('deviceToken');

    if (!tokens.length) {
      return result;
    }

    const registrationTokens = tokens.map(
      (token) => token.deviceToken
    );

    result.total = registrationTokens.length;

    const message = {
      ...buildMessage(title, body, data),
      tokens: registrationTokens,
    };

    const response =
      await messaging.sendEachForMulticast(message);

    result.sent = response.successCount;
    result.failed = response.failureCount;

    // Remove invalid or unregistered tokens.
    if (response.failureCount > 0) {
      const invalidTokens = [];

      response.responses.forEach((resp, index) => {
        if (!resp.success) {
          const code = resp.error?.code;

          if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token'
          ) {
            invalidTokens.push(registrationTokens[index]);
          }
        }
      });

      if (invalidTokens.length) {
        await DeviceToken.deleteMany({
          deviceToken: {
            $in: invalidTokens,
          },
        });

        logger.info(
          { invalidCount: invalidTokens.length },
          'Cleaned up invalid FCM tokens'
        );
      }
    }

    logger.debug(
      { userId, result },
      'Push sent to user'
    );

    return result;
  } catch (err) {
    logger.error(
      { err, userId },
      'Push sendToUser failed'
    );

    return result;
  }
}

/**
 * Send a push notification to multiple registration tokens.
 */
export async function sendMulticast(
  tokens,
  title,
  body,
  data = {}
) {
  if (!tokens || tokens.length === 0) {
    return {
      sent: 0,
      failed: 0,
      total: 0,
    };
  }

  if (!isReady()) return null;

  try {
    const message = {
      ...buildMessage(title, body, data),
      tokens,
    };

    // FCM multicast supports at most 500 tokens per request.
    const response =
      await messaging.sendEachForMulticast(message);

    const result = {
      sent: response.successCount,
      failed: response.failureCount,
      total: tokens.length,
    };

    logger.debug(
      { result },
      'Push multicast sent'
    );

    return result;
  } catch (err) {
    logger.error(
      { err, tokenCount: tokens.length },
      'Push sendMulticast failed'
    );

    return null;
  }
}

/**
 * Send a push notification to a topic.
 */
export async function sendToTopic(
  topic,
  title,
  body,
  data = {}
) {
  if (!isReady()) return null;

  try {
    const message = {
      ...buildMessage(title, body, data),
      topic,
    };

    const response = await messaging.send(message);

    logger.debug(
      { topic, response },
      'Push sent to topic'
    );

    return response;
  } catch (err) {
    logger.error(
      { err, topic },
      'Push sendToTopic failed'
    );

    return null;
  }
}

/**
 * Get Firebase Messaging instance.
 */
export function getFCM() {
  return messaging;
}

/**
 * Get initialization error.
 */
export function getFCMError() {
  return fcmInitError;
}

export { fcmInitError };
