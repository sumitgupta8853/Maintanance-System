import amqplib from 'amqplib';
import Ticket from '../Models/Ticket.js';
import { logger } from '../utils/logger.js';

let channel;
let consuming = false;

/**
 * Start the RabbitMQ escalation worker
 * Consumes ticket:escalated events and auto-updates ticket status to urgent
 */
export const startEscalationWorker = async () => {
  try {
    const conn = await amqplib.connect(process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672');
    channel = await conn.createChannel();

    // Ensure queue exists
    await channel.assertQueue('escalation_queue', { durable: true, maxLength: 200, deadLetterExchange: 'ticket_dlx' });

    // Set prefetch
    await channel.prefetch(50);

    channel.consume('escalation_queue', async (msg) => {
      if (msg !== null) {
        let escalationData;
        try {
          escalationData = JSON.parse(msg.content.toString());
        } catch (parseErr) {
          logger.error({ err: parseErr }, 'Failed to parse escalation message');
          channel.nack(msg, false, true);
          return;
        }

        try {
          const { ticketId, oldStatus } = escalationData;

          const ticket = await Ticket.findById(ticketId);

          if (ticket && ticket.status !== 'urgent') {
            ticket.status = 'urgent';
            ticket.escalatedAt = new Date();
            ticket.updatedAt = new Date();
            await ticket.save();

            logger.info(`🚀 Ticket ${ticket.ticketNumber} auto-escalated to urgent`, {
              ticketId,
              oldStatus,
              newStatus: 'urgent'
            });
          }

          // Acknowledge message
          channel.ack(msg);

        } catch (err) {
          logger.error({ err }, 'Escalation worker failed');
          // Requeue the message
          channel.nack(msg, false, true);
        }
      }
    });

    consuming = true;
    logger.info('🐇 RabbitMQ escalation worker started');

  } catch (err) {
    logger.error({ err }, 'Failed to start escalation worker');
    setTimeout(() => startEscalationWorker(), 5000);
  }
};

/**
 * Stop the escalation worker
 */
export const stop = async () => {
  consuming = false;
  if (channel) {
    try {
      await channel.close();
    } catch (err) {
      logger.error({ err }, 'Error closing escalation worker channel');
    }
  }
};