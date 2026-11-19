import AuditLog from '../Models/AuditLog.js';
import { logger } from './logger.js';

// Deferred audit logging: write to DB in next event loop iteration
// to prevent blocking API responses under high load
const deferAuditLog = async (auditData) => {
  try {
    await AuditLog.create(auditData);
  } catch (err) {
    logger.error({ err }, 'Deferred audit log failed');
  }
};

export const auditLog = async ({
  actor,
  action,
  target,
  targetType,
  targetId,
  outcome,
  details,
  req,
}) => {
  try {
    const auditData = {
      actor: actor || null,
      action,
      targetType: targetType || null,
      targetId: targetId || (target ? target._id : null),
      outcome,
      details: details || null,
      ip: req ? (req.ip || req.connection?.remoteAddress || null) : null,
      userAgent: req ? req.headers['user-agent'] || null : null,
    };

    // Use setImmediate to defer DB write and return immediately
    // This prevents audit logging from blocking the API response
    setImmediate(() => deferAuditLog(auditData));
  } catch (err) {
    // Audit logging must never break the main request flow
    logger.error({ err }, 'Audit log failed');
  }
};
