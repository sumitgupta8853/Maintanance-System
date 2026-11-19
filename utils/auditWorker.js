import amqplib from 'amqplib';
import AuditLog from '../Models/AuditLog.js';
import { logger } from './logger.js';

let channel;
let consuming = false;

/**
 * Start the RabbitMQ audit worker
 * Consumes ticket:history events and writes to MongoDB AuditLog
 */
export const startAuditWorker = async () => {
  try {
    const conn = await amqplib.connect(process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672');
    channel = await conn.createChannel();

    // Ensure queue exists
    await channel.assertQueue('audit_queue', { durable: true, maxLength: 5000, deadLetterExchange: 'ticket_dlx' });

    // Set prefetch for fair dispatch
    await channel.prefetch(50);

    channel.consume('audit_queue', async (msg) => {
      if (msg !== null) {
        let auditData;
        try {
          auditData = JSON.parse(msg.content.toString());
        } catch (parseErr) {
          logger.error({ err: parseErr }, 'Failed to parse audit message');
          channel.nack(msg, false, true);
          return;
        }

        try {
          await AuditLog.create({
            actor: auditData.actor,
            action: auditData.action,
            targetType: auditData.targetType,
            targetId: auditData.targetId,
            outcome: auditData.outcome,
            details: auditData.details,
            ip: auditData.ip,
            userAgent: auditData.userAgent
          });

          // Acknowledge message (remove from queue)
          channel.ack(msg);
          logger.debug('📝 Audit log written from queue', { action: auditData?.action });

        } catch (dbErr) {
          logger.error({ err: dbErr }, 'Audit worker DB write failed');
          // Requeue the message for later processing
          channel.nack(msg, false, true);
        }
      }
    });

    consuming = true;
    logger.info('🐇 RabbitMQ audit worker started');

  } catch (err) {
    logger.error({ err }, 'Failed to start audit worker');
    setTimeout(() => startAuditWorker(), 5000);
  }
};

/**
 * Stop the audit worker
 */
export const stop = async () => {
  consuming = false;
  if (channel) {
    try {
      await channel.close();
    } catch (err) {
      logger.error({ err }, 'Error closing audit worker channel');
    }
  }
};