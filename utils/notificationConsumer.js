import amqplib from 'amqplib';
import { notifyTicketEvent } from './pushNotification.js';
import { logger } from './logger.js';

const QUEUE = 'notification_queue';
const RETRY_DELAY_MS = 5000;
const HANDLER_TIMEOUT_MS = 30000;

let connection;
let channel;
let stopping = false;
let restartTimer = null;

// Never wait forever on FCM / DB calls
const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Handler timed out after ${ms}ms`)), ms)
    ),
  ]);

const scheduleRestart = () => {
  if (stopping || restartTimer) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startNotificationConsumer();
  }, RETRY_DELAY_MS);
};

const handleMessage = async (msg) => {
  // null means the server cancelled the consumer
  if (msg === null) {
    logger.warn('Notification consumer was cancelled by the server');
    return;
  }

  let event;
  try {
    event = JSON.parse(msg.content.toString());
  } catch (parseErr) {
    logger.error({ err: parseErr }, 'Failed to parse RabbitMQ message');
    // An unparseable message can never succeed, so don't requeue it
    channel.nack(msg, false, false);
    return;
  }

  try {
    const routingKey = msg.fields.routingKey || 'ticket:commented';

    switch (routingKey) {
      case 'ticket:created':
        logger.info({ ticketId: event.ticketId }, '🎫 Ticket created event received');
        break;

      case 'ticket:commented':
        if (event.ticketId && event.author) {
          await withTimeout(
            notifyTicketEvent({
              ticket: { ticketNumber: event.ticketNumber || event.ticketId },
              userId: event.author,
              isInternalNote: event.isInternalNote || false,
            }),
            HANDLER_TIMEOUT_MS
          );
        }
        logger.info({ ticketId: event.ticketId }, '💬 Comment notification sent');
        break;

      case 'ticket:closed':
        logger.info({ ticketId: event.ticketId }, '🎟️ Ticket closed event received');
        break;

      default:
        if (event.ticketId) {
          await withTimeout(
            notifyTicketEvent({
              ticket: { ticketNumber: event.ticketNumber || event.ticketId },
              userId: event.author,
              isInternalNote: event.isInternalNote || false,
            }),
            HANDLER_TIMEOUT_MS
          );
        }
    }

    channel.ack(msg);
    logger.debug({ routingKey, ticketId: event?.ticketId }, '📬 Notification processed');
  } catch (err) {
    logger.error({ err }, 'Notification processing error');
    // Don't requeue: avoids an endless redelivery loop on a failing message
    channel.nack(msg, false, false);
  }
};

/**
 * Initialize and start the RabbitMQ notification consumer.
 * Listens to the ticket_events exchange and delivers Firebase push notifications.
 */
export const startNotificationConsumer = async () => {
  stopping = false;
  try {
    connection = await amqplib.connect(
      process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672'
    );
    channel = await connection.createChannel();

    // Without these listeners, a closed channel crashes the whole process
    connection.on('error', (err) =>
      logger.error({ err }, 'RabbitMQ connection error (notification consumer)')
    );
    connection.on('close', () => {
      logger.warn('RabbitMQ connection closed (notification consumer)');
      scheduleRestart();
    });
    channel.on('error', (err) =>
      logger.error({ err }, 'RabbitMQ channel error (notification consumer)')
    );

    // Must match the options in middlewares/publisher.js exactly
    await channel.assertQueue(QUEUE, {
      durable: true,
      maxLength: 1000,
      deadLetterExchange: 'ticket_dlx',
    });

    channel.prefetch(5);
    await channel.consume(QUEUE, handleMessage, { noAck: false });

    logger.info('🐇 RabbitMQ notification consumer started');
  } catch (err) {
    logger.error({ err }, 'Failed to start notification consumer');
    try {
      await connection?.close();
    } catch (_) {
      /* connection may already be closed */
    }
    scheduleRestart();
  }
};

/**
 * Stop the notification consumer
 */
export const stop = async () => {
  stopping = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  try {
    await channel?.close();
    await connection?.close();
  } catch (err) {
    logger.error({ err }, 'Error closing notification consumer');
  }
};


