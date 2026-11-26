import Ticket from '../Models/Ticket.js';
import AssignmentRequest from '../Models/AssignmentRequest.js';
import User from '../Models/User.js';
import { sendToUser } from '../utils/pushNotification.js';
import { auditLog } from '../utils/audit.js';
import { logger } from '../utils/logger.js';

function canApproveAssignment(user) {
  const perms = user?.role?.permissions || [];
  const roleName = user?.role?.name;

  if (perms.includes('*') || perms.includes('ticket:all_departments')) {
    return true;
  }
  if (
    roleName === 'technical_manager' ||
    roleName === 'customer_support_manager'
  ) {
    return true;
  }
  return false;
}

export async function getMyRequests(req, res) {
  try {
    const userId = req.user._id;
    const requests = await AssignmentRequest.find({ requestedBy: userId })
      .populate('ticket', 'ticketNumber subject status type priority createdAt')
      .populate('reviewedBy', 'name email')
      .sort({ requestedAt: -1 });

    return res.json({ requests });
  } catch (err) {
    logger.error({ err }, 'getMyRequests failed');
    return res.status(500).json({ message: 'Could not fetch your requests' });
  }
}

export async function getPendingRequests(req, res) {
  try {
    if (!canApproveAssignment(req.user)) {
      return res.status(403).json({
        message: 'Only admin, customer_support_manager, or technical_manager can view pending requests',
      });
    }

    const requests = await AssignmentRequest.find({ status: 'pending' })
      .populate('ticket', 'ticketNumber subject status type priority createdAt departmentId')
      .populate('requestedBy', 'name email')
      .sort({ requestedAt: -1 });

    return res.json({ requests });
  } catch (err) {
    logger.error({ err }, 'getPendingRequests failed');
    return res.status(500).json({ message: 'Could not fetch pending requests' });
  }
}

export async function requestAssignment(req, res) {
  try {
    const user = req.user;
    const roleName = user.role?.name;
    const { ticketId } = req.params;

    if (roleName !== 'service_engineer') {
      return res.status(403).json({
        message: 'Only service engineers can request assignment',
      });
    }

    if (!ticketId || typeof ticketId !== 'string') {
      return res.status(400).json({ message: 'ticketId is required' });
    }

    const ticket = await Ticket.findById(ticketId).lean();
    if (!ticket) {
      return res.status(404).json({ message: 'Ticket not found' });
    }
    if (ticket.type !== 'auto') {
      return res.status(400).json({ message: 'Only auto tickets can be requested' });
    }
    if (ticket.assignedTo) {
      return res.status(400).json({ message: 'Ticket is already assigned' });
    }
    const closedStatuses = ['resolved', 'closed', 'reopened'];
    if (closedStatuses.includes(ticket.status)) {
      return res.status(400).json({ message: `Cannot request assignment for a ${ticket.status} ticket` });
    }

    const existing = await AssignmentRequest.findOne({
      ticket: ticketId,
      requestedBy: user._id,
      status: 'pending',
    });
    if (existing) {
      return res.status(409).json({
        message: 'You already have a pending request for this ticket',
      });
    }

    const request = await AssignmentRequest.create({
      ticket: ticketId,
      requestedBy: user._id,
      status: 'pending',
    });

    // Notify all admins / CSMs / TMs of the new request
    try {
      const approvers = await User.find({
        isActive: true,
      }).populate('role');

      const notifyUserIds = new Set();
      for (const u of approvers) {
        const perms = u.role?.permissions || [];
        const rName = u.role?.name;
        if (
          perms.includes('*') ||
          perms.includes('ticket:all_departments') ||
          rName === 'technical_manager' ||
          rName === 'customer_support_manager'
        ) {
          notifyUserIds.add(String(u._id));
        }
      }

      await Promise.allSettled(
        [...notifyUserIds].map((uid) =>
          sendToUser(uid, `New Assignment Request`, `Service engineer ${user.name} requested assignment to ticket #${ticket.ticketNumber}`, {
            type: 'ticket_assignment_requested',
            ticketId: ticket._id.toString(),
            ticketNumber: ticket.ticketNumber,
            requestId: request._id.toString(),
            requestedBy: user._id.toString(),
          })
        )
      );
    } catch (notifyErr) {
      logger.error({ err: notifyErr }, 'Failed to notify approvers of new assignment request');
    }

    return res.status(201).json({
      message: 'Assignment request submitted',
      request: {
        id: request._id,
        ticketId: request.ticket,
        ticketNumber: ticket.ticketNumber,
        status: request.status,
        requestedAt: request.requestedAt,
      },
    });
  } catch (err) {
    logger.error({ err }, 'requestAssignment failed');
    return res.status(500).json({ message: 'Could not submit assignment request' });
  }
}

export async function approveRequest(req, res) {
  try {
    if (!canApproveAssignment(req.user)) {
      return res.status(403).json({
        message: 'Only admin, customer_support_manager, or technical_manager can approve assignment requests',
      });
    }

    const { id } = req.params;

    const request = await AssignmentRequest.findById(id).populate('ticket');
    if (!request) {
      return res.status(404).json({ message: 'Assignment request not found' });
    }
    if (request.status !== 'pending') {
      return res.status(400).json({ message: `Request is already ${request.status}` });
    }

    const ticket = request.ticket;
    if (!ticket) {
      return res.status(404).json({ message: 'Associated ticket not found' });
    }
    if (ticket.assignedTo) {
      return res.status(400).json({ message: 'Ticket is already assigned' });
    }

    const closedStatuses = ['resolved', 'closed', 'reopened'];
    if (closedStatuses.includes(ticket.status)) {
      return res.status(400).json({ message: `Cannot assign a ${ticket.status} ticket` });
    }

    request.status = 'approved';
    request.reviewedBy = req.user._id;
    request.reviewedAt = new Date();
    await request.save();

    ticket.assignedTo = request.requestedBy;
    ticket.status = 'assigned';
    ticket.updatedAt = new Date();
    await ticket.save();

    try {
      await sendToUser(
        request.requestedBy,
        `Assignment Request Approved`,
        `Your request for ticket #${ticket.ticketNumber} has been approved. The ticket is now assigned to you.`,
        {
          type: 'ticket_assignment_approved',
          ticketId: ticket._id.toString(),
          ticketNumber: ticket.ticketNumber,
          requestId: request._id.toString(),
        }
      );
    } catch (notifyErr) {
      logger.error({ err: notifyErr }, 'Failed to notify requester of approval');
    }

    await auditLog({
      actor: req.user._id,
      action: 'ticket:approve_assign_request',
      target: ticket,
      targetType: 'Ticket',
      targetId: ticket._id,
      outcome: 'success',
      details: {
        ticketNumber: ticket.ticketNumber,
        assignedTo: request.requestedBy,
        requestId: request._id,
        reviewedBy: req.user._id,
      },
      req,
    });

    return res.json({
      message: 'Assignment request approved',
      ticket: {
        id: ticket._id,
        ticketNumber: ticket.ticketNumber,
        status: ticket.status,
        assignedTo: ticket.assignedTo,
      },
      request: {
        id: request._id,
        status: request.status,
        reviewedBy: request.reviewedBy,
        reviewedAt: request.reviewedAt,
      },
    });
  } catch (err) {
    logger.error({ err }, 'approveRequest failed');
    return res.status(500).json({ message: 'Could not approve assignment request' });
  }
}

export async function rejectRequest(req, res) {
  try {
    if (!canApproveAssignment(req.user)) {
      return res.status(403).json({
        message: 'Only admin, customer_support_manager, or technical_manager can reject assignment requests',
      });
    }

    const { id } = req.params;
    const { reviewNotes } = req.body;

    const request = await AssignmentRequest.findById(id).populate('ticket');
    if (!request) {
      return res.status(404).json({ message: 'Assignment request not found' });
    }
    if (request.status !== 'pending') {
      return res.status(400).json({ message: `Request is already ${request.status}` });
    }

    request.status = 'rejected';
    request.reviewedBy = req.user._id;
    request.reviewedAt = new Date();
    request.reviewNotes = reviewNotes || null;
    await request.save();

    try {
      await sendToUser(
        request.requestedBy,
        `Assignment Request Rejected`,
        `Your request for ticket #${request.ticket?.ticketNumber || 'unknown'} has been rejected.`,
        {
          type: 'ticket_assignment_rejected',
          ticketId: request.ticket?.ticketId?.toString() || request.ticket?.toString(),
          ticketNumber: request.ticket?.ticketNumber || '',
          requestId: request._id.toString(),
          reviewNotes: request.reviewNotes || '',
        }
      );
    } catch (notifyErr) {
      logger.error({ err: notifyErr }, 'Failed to notify requester of rejection');
    }

    await auditLog({
      actor: req.user._id,
      action: 'ticket:reject_assign_request',
      target: request.ticket,
      targetType: 'Ticket',
      targetId: request.ticket,
      outcome: 'success',
      details: {
        ticketNumber: request.ticket?.ticketNumber,
        requestId: request._id,
        reviewedBy: req.user._id,
        reviewNotes,
      },
      req,
    });

    return res.json({
      message: 'Assignment request rejected',
      request: {
        id: request._id,
        status: request.status,
        reviewedBy: request.reviewedBy,
        reviewedAt: request.reviewedAt,
        reviewNotes: request.reviewNotes,
      },
    });
  } catch (err) {
    logger.error({ err }, 'rejectRequest failed');
    return res.status(500).json({ message: 'Could not reject assignment request' });
  }
}
