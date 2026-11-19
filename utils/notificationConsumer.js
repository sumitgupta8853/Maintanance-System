import amqplib from 'amqplib';
import { notifyTicketEvent } from './pushNotification.js';
import { logger } from './logger.js';

let channel;
let consuming = false;

/**
 * Initialize and start the RabbitMQ notification consumer
 * Listens to ticket_events exchange and delivers Firebase push notifications
 */
export const startNotificationConsumer = async () => {
  try {
    const conn = await amqplib.connect(process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672');
    channel = await conn.createChannel();

    // Ensure queue exists and is bound
    await channel.assertQueue('notification_queue', { durable: true, maxLength: 1000, deadLetterExchange: 'ticket_dlx' });

    // Start consuming messages
    channel.consume('notification_queue', async (msg) => {
      if (msg !== null && !consuming) {
        let event;
        try {
          event = JSON.parse(msg.content.toString());
        } catch (parseErr) {
          logger.error({ err: parseErr }, 'Failed to parse RabbitMQ message');
          channel.nack(msg, false, true);
          return;
        }

        try {
          // Map routing key to notification logic
          const routingKey = msg.fields.routingKey || 'ticket:commented';

          switch (routingKey) {
            case 'ticket:created':
              // Could send assignment notification to assigned engineer
              logger.info('🎫 Ticket created event received', { ticketId: event.ticketId });
              break;

            case 'ticket:commented':
              // Notify ticket author/assignee about new comment
              if (event.ticketId && event.author) {
                await notifyTicketEvent({
                  ticket: { ticketNumber: event.ticketNumber || event.ticketId },
                  userId: event.author,
                  isInternalNote: event.isInternalNote || false
                });
              }
              logger.info('💬 Comment notification sent', { ticketId: event.ticketId });
              break;

            case 'ticket:closed':
              // Notify all stakeholders about ticket closure
              logger.info('🎟️ Ticket closed event received', { ticketId: event.ticketId });
              break;

            default:
              // Default to comment notification
              if (event.ticketId) {
                await notifyTicketEvent({
                  ticket: { ticketNumber: event.ticketNumber || event.ticketId },
                  userId: event.author,
                  isInternalNote: event.isInternalNote || false
                });
              }
          }

          // Acknowledge message (remove from queue)
          channel.ack(msg);
          logger.debug('📬 Notification processed', { routingKey, ticketId: event?.ticketId });

        } catch (err) {
          logger.error({ err }, 'Notification processing error');
          // NACK - requeue the message for later processing
          channel.nack(msg, false, true);
        }
      }
    });

    consuming = true;
    logger.info('🐇 RabbitMQ notification consumer started');

  } catch (err) {
    logger.error({ err }, 'Failed to start notification consumer');
    // Retry after a delay
    setTimeout(() => startNotificationConsumer(), 5000);
  }
};

/**
 * Stop the notification consumer
 */
export const stop = async () => {
  consuming = false;
  if (channel) {
    try {
      await channel.close();
    } catch (err) {
      logger.error({ err }, 'Error closing notification consumer channel');
    }
  }
};


