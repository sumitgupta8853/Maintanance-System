import AuditLog from '../Models/AuditLog.js';

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
    await AuditLog.create({
      actor: actor || null,
      action,
      targetType: targetType || null,
      targetId: targetId || (target ? target._id : null),
      outcome,
      details: details || null,
      ip: req ? (req.ip || req.connection?.remoteAddress || null) : null,
      userAgent: req ? req.headers['user-agent'] || null : null,
    });
  } catch (err) {
    // Audit logging must never break the main request flow
    console.error('Audit log failed:', err.message);
  }
};
