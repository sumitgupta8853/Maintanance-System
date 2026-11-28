import mongoose from 'mongoose';
import Ticket from '../Models/Ticket.js';
import { notifyTicketEvent } from '../utils/pushNotification.js';
import { logger } from '../utils/logger.js';

const CLOSED_STATUSES = ['resolved', 'closed', 'reopened']; // confirm 'reopened'
const MAX_SELF_ASSIGNED = 5;

export async function selfAssignTicket(req, res) {
  const user = req.user;
  const { ticketId } = req.params;

  if (user.role?.name !== 'service_engineer') {
    return res.status(403).json({ message: 'Only service engineers can self-assign tickets' });
  }
  if (!mongoose.isValidObjectId(ticketId)) {
    return res.status(400).json({ message: 'Invalid ticketId' });
  }

  try {
    const selfCount = await Ticket.countDocuments({
      assignedTo: user._id,
      selfAssigned: true,
      status: { $nin: CLOSED_STATUSES },
    });
    if (selfCount >= MAX_SELF_ASSIGNED) {
      return res.status(409).json({
        message: `You already have ${selfCount} active self-assigned tickets. The maximum is ${MAX_SELF_ASSIGNED}.`,
      });
    }

    const ticket = await Ticket.findOneAndUpdate(
      { _id: ticketId, type: 'auto', assignedTo: null, status: { $nin: CLOSED_STATUSES } },
      { $set: { assignedTo: user._id, selfAssigned: true, status: 'assigned', updatedAt: new Date() } },
      { new: true, runValidators: true }
    );

    if (!ticket) {
      const exists = await Ticket.exists({ _id: ticketId });
      return exists
        ? res.status(409).json({ message: 'Ticket is not available for self-assignment' })
        : res.status(404).json({ message: 'Ticket not found' });
    }

    const notification = await notifyTicketEvent(ticket, 'ticket_assigned', user._id);
    logger.info(
      { ticketId, departmentId: ticket.departmentId, notification },
      'Self-assign notification result'
    );

    return res.json({
      message: 'Ticket self-assigned successfully',
      notification, // temporary, remove after debugging
      ticket: {
        id: ticket._id,
        ticketNumber: ticket.ticketNumber,
        status: ticket.status,
        assignedTo: ticket.assignedTo,
      },
    });
  } catch (err) {
    logger.error({ err, ticketId, userId: user._id }, 'selfAssignTicket failed');
    return res.status(500).json({ message: 'Could not self-assign ticket' });
  }
}