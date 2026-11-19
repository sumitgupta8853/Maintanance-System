import amqplib from 'amqplib';
import { logger } from '../utils/logger.js';

let connection;
let channel;

/**
 * Initialize RabbitMQ connection and declare exchanges/queues
 * Call this once at application startup
 */
export const initRabbitMQ = async () => {
  try {
    connection = await amqplib.connect('amqp://guest:guest@localhost:5672');
    channel = await connection.createChannel();

    // Declare direct exchange for ticket events
    await channel.assertExchange('ticket_events', 'direct', {
      durable: true,
      autoDelete: false
    });

    // Declare dead-letter exchange
    await channel.assertExchange('ticket_dlx', 'direct', {
      durable: true,
      autoDelete: false
    });

    // ============= NOTIFICATION QUEUE =============
    await channel.assertQueue('notification_queue', {
      durable: true,
      maxLength: 1000,
      deadLetterExchange: 'ticket_dlx'
    });

    // Bind notification routing keys
    await channel.bindQueue('notification_queue', 'ticket_events', 'ticket:created');
    await channel.bindQueue('notification_queue', 'ticket_events', 'ticket:commented');
    await channel.bindQueue('notification_queue', 'ticket_events', 'ticket:closed');

    // ============= AUDIT QUEUE =============
    await channel.assertQueue('audit_queue', {
      durable: true,
      maxLength: 5000,
      deadLetterExchange: 'ticket_dlx'
    });

    await channel.bindQueue('audit_queue', 'ticket_events', 'ticket:history');

    // ============= ESCALATION QUEUE =============
    await channel.assertQueue('escalation_queue', {
      durable: true,
      maxLength: 200,
      deadLetterExchange: 'ticket_dlx'
    });

    await channel.bindQueue('escalation_queue', 'ticket_events', 'ticket:escalated');

    // ============= DLQ =============
    await channel.assertQueue('notification_dlq', {
      durable: true
    });

    await channel.bindQueue('notification_dlq', 'ticket_dlx', 'notification_failed');

    logger.info('🐇 RabbitMQ initialized successfully');
  } catch (err) {
    logger.error({ err }, 'RabbitMQ initialization failed');
    // Don't throw - allow app to start without RabbitMQ
  }
};

/**
 * Publish a message to the ticket_events exchange
 * @param {string} routingKey - e.g. 'ticket:created', 'ticket:commented'
 * @param {object} message - The payload to publish
 * @returns {boolean} true if published successfully
 */
export const publish = async (routingKey, message) => {
  if (!channel) {
    logger.debug('RabbitMQ not connected, skipping publish', { routingKey });
    return false;
  }

  try {
    await channel.publish(
      'ticket_events',
      routingKey,
      Buffer.from(JSON.stringify(message)),
      { persistent: true } // Survive broker restarts
    );
    return true;
  } catch (err) {
    logger.error({ err }, 'Failed to publish to RabbitMQ', { routingKey });
    return false;
  }
};

/**
 * Close RabbitMQ connection on application shutdown
 */
export const close = async () => {
  try {
    if (channel) await channel.close();
    if (connection) await connection.close();
  } catch (err) {
    logger.error({ err }, 'Error closing RabbitMQ connection');
  }
};