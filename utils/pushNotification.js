import { logger } from './logger.js';
import DeviceToken from '../Models/DeviceToken.js';
import User from '../Models/User.js';

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

/**
 * Build the standard push payload for a ticket event.
 */
function ticketPayload(ticket, eventType, actorName = 'System') {
  const base = {
    ticketId: ticket._id.toString(),
    ticketNumber: ticket.ticketNumber,
    event: eventType,
    deepLink: `/tickets/${ticket.ticketNumber}`,
  };

  const messages = {
    ticket_created: {
      title: 'New Ticket Created',
      body: `Ticket #${ticket.ticketNumber}: ${ticket.subject}`,
    },
    ticket_assigned: {
      title: 'Ticket Assigned to You',
      body: `Ticket #${ticket.ticketNumber} (${ticket.subject}) has been assigned to you`,
    },
    ticket_status_updated: {
      title: 'Ticket Status Updated',
      body: `Ticket #${ticket.ticketNumber} status changed`,
    },
    ticket_commented: {
      title: 'New Comment on Ticket',
      body: `New comment on ticket #${ticket.ticketNumber} (${ticket.subject})`,
    },
    ticket_closed: {
      title: 'Ticket Closed',
      body: `Ticket #${ticket.ticketNumber} (${ticket.subject}) has been closed`,
    },
  };

  return {
    ...base,
    ...(messages[eventType] || { title: 'Ticket Update', body: `Ticket #${ticket.ticketNumber}` }),
    actor: actorName,
  };
}

/**
 * Return active users in a department who should receive ticket notifications:
 * technical_manager role, wildcard (*) permission, or ticket:view_department permission.
 * Returns a Set of unique user ObjectId strings.
 */
async function getDepartmentNotifyUsers(departmentId, userModel = User) {
  const userIds = new Set();
  if (!departmentId) return userIds;
  const managers = await userModel.find({
    departmentId,
    isActive: true,
  }).populate('role');
  for (const m of managers) {
    const roleName = m.role?.name;
    const perms = m.role?.permissions || [];
    if (
      roleName === 'technical_manager' ||
      perms.includes('*') ||
      perms.includes('ticket:view_department')
    ) {
      userIds.add(m._id.toString());
    }
  }
  return userIds;
}

/**
 * Determine which users should be notified for a given ticket event.
 * Returns an array of unique user ObjectIds.
 */
async function resolveNotifyUsers(ticket, eventType, actorId, userModel = User) {
  const notify = new Set();

  switch (eventType) {
    case 'ticket_created':
      if (ticket.departmentId) {
        const deptUsers = await getDepartmentNotifyUsers(ticket.departmentId, userModel);
        for (const id of deptUsers) notify.add(id);
      }
      break;

    case 'ticket_assigned':
      // Notify the assigned engineer (service engineer / technical manager the ticket was assigned to)
      if (ticket.assignedTo) notify.add(ticket.assignedTo.toString());
      // Notify department managers (technical_manager, wildcard, or ticket:view_department)
      // so they stay aware of assignments in their department
      if (ticket.departmentId) {
        const deptUsers = await getDepartmentNotifyUsers(ticket.departmentId, userModel);
        for (const id of deptUsers) notify.add(id);
      }
      // Don't notify the actor (the manager/engineer who performed the assignment)
      if (actorId) notify.delete(actorId.toString());
      break;

    case 'ticket_status_updated':
      if (ticket.createdBy) notify.add(ticket.createdBy.toString());
      if (ticket.assignedTo) notify.add(ticket.assignedTo.toString());
      if (ticket.assignedBy) notify.add(ticket.assignedBy.toString());
      // Notify department managers (technical_manager, wildcard, or ticket:view_department)
      if (ticket.departmentId) {
        const deptUsers = await getDepartmentNotifyUsers(ticket.departmentId, userModel);
        for (const id of deptUsers) notify.add(id);
      }
      if (actorId) notify.delete(actorId.toString()); // don't notify the actor
      break;

    case 'ticket_commented':
      if (ticket.createdBy) notify.add(ticket.createdBy.toString());
      if (ticket.assignedTo) notify.add(ticket.assignedTo.toString());
      if (actorId) notify.delete(actorId.toString()); // don't notify the commenter
      break;

    case 'ticket_closed':
      if (ticket.createdBy) notify.add(ticket.createdBy.toString());
      if (ticket.assignedTo) notify.add(ticket.assignedTo.toString());
      if (ticket.assignedBy) notify.add(ticket.assignedBy.toString());
      // Notify department managers (technical_manager, wildcard, or ticket:view_department)
      if (ticket.departmentId) {
        const deptUsers = await getDepartmentNotifyUsers(ticket.departmentId, userModel);
        for (const id of deptUsers) notify.add(id);
      }
      if (actorId) notify.delete(actorId.toString()); // don't notify the actor
      break;
  }

  return [...notify];
}

/**
 * Send push notifications for a ticket lifecycle event.
 * Best-effort: failures are logged and never thrown.
 *
 * @param {object} ticket - Mongoose ticket document (populated fields: createdBy, assignedTo, departmentId)
 * @param {string} eventType - ticket_created | ticket_assigned | ticket_status_updated | ticket_commented | ticket_closed
 * @param {string|ObjectId} actorId - user who triggered the event
 * @param {object} [extraData] - extra data fields to include in the push payload
 */
export async function notifyTicketEvent(ticket, eventType, actorId, extraData = {}) {
  try {
    const payload = ticketPayload(ticket, eventType);
    const userIds = await resolveNotifyUsers(ticket, eventType, actorId);

    if (!userIds.length) {
      logger.debug({ eventType, ticketNumber: ticket.ticketNumber }, 'No users to notify for ticket event');
      return { sent: 0, failed: 0, total: 0, notifiedUsers: 0 };
    }

    const results = await Promise.allSettled(
      userIds.map((uid) =>
        sendToUser(uid, payload.title, payload.body, {
          ...payload,
          ...extraData,
        })
      )
    );

    let sent = 0;
    let failed = 0;
    let total = 0;

    for (const r of results) {
      if (r.status === 'fulfilled') {
        sent += r.value.sent || 0;
        failed += r.value.failed || 0;
        total += r.value.total || 0;
      } else {
        failed += 1;
        total += 1;
        logger.error({ err: r.reason, eventType }, 'notifyTicketEvent per-user failure');
      }
    }

    logger.info({
      eventType,
      ticketNumber: ticket.ticketNumber,
      notifiedUsers: userIds.length,
      sent,
      failed,
      total,
    }, 'Ticket event push notifications sent');

    return { sent, failed, total, notifiedUsers: userIds.length };
  } catch (err) {
    logger.error({ err, eventType, ticketNumber: ticket.ticketNumber }, 'notifyTicketEvent failed');
    return { sent: 0, failed: 0, total: 0, notifiedUsers: 0, error: err.message };
  }
}

export { getDepartmentNotifyUsers, resolveNotifyUsers };