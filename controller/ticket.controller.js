import Ticket from '../Models/Ticket.js';
import TicketHistory from '../Models/TicketHistory.js';
import TicketComment from '../Models/TicketComment.js';
import User from '../Models/User.js';
import Department from '../Models/Department.js';
import { ticketAccessFilter, ticketInScope } from '../utils/ticketAccess.js';
import { auditLog } from '../utils/audit.js';

const TEAM_MEMBER_ALLOWED_TRANSITIONS = {
  open: ['assigned', 'in_progress', 'partially_resolved', 'waiting_for_parts', 'on_hold'],
  assigned: ['in_progress', 'partially_resolved', 'waiting_for_parts', 'on_hold'],
  in_progress: ['resolved', 'in_progress', 'partially_resolved', 'waiting_for_parts', 'on_hold', 'open'],
  partially_resolved: ['in_progress', 'waiting_for_parts', 'on_hold', 'resolved'],
  waiting_for_parts: ['in_progress', 'on_hold', 'resolved'],
  on_hold: ['in_progress', 'waiting_for_parts', 'resolved'],
  resolved: ['closed'],
  closed: ['reopened'],
  reopened: ['in_progress', 'assigned']
};

async function recordFieldChange(ticketId, field, oldValue, newValue, changedBy, note) {
  try {
    await TicketHistory.create({ ticketId, type: 'field', field, oldValue, newValue, note, changedBy });
  } catch (err) {
    console.error('Ticket history field write failed:', err.message);
  }
}

async function recordStatusChange(ticketId, oldStatus, newStatus, changedBy, note) {
  try {
    await TicketHistory.create({ ticketId, type: 'status', field: 'status', oldValue: oldStatus, newValue: newStatus, note, changedBy });
  } catch (err) { console.error('Ticket history status write failed:', err.message); }
}

async function checkAndEscalateTicket(ticket) {
  try {
    if (!ticket) return ticket;
    if (ticket.status !== 'open') return ticket;
    if (ticket.escalatedAt) return ticket;
    const ageInHours = (Date.now() - new Date(ticket.createdAt).getTime()) / (1000 * 60 * 60);
    const threshold = ticket.escalationHours || 24;
    if (ageInHours > threshold) {
      const oldStatus = ticket.status;
      ticket.status = 'urgent';
      ticket.escalatedAt = new Date();
      ticket.updatedAt = new Date();
      await ticket.save();
      await recordStatusChange(ticket._id, oldStatus, 'urgent', null, 'Auto-escalated due to age threshold');
    }
  } catch (err) { console.error('Escalation check failed:', err.message); }
  return ticket;
}

export const getAllTickets = async (req, res, next) => {
  try {
    const user = req.user;
    const { status, priority, departmentId, search, page = 1, limit = 10 } = req.query;
    const filter = ticketAccessFilter(user);
    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    if (departmentId) filter.departmentId = departmentId;
    if (search) {
      filter.$or = [...(filter.$or || []), { subject: { $regex: search, $options: 'i' } }, { ticketNumber: { $regex: search, $options: 'i' } }, { customerName: { $regex: search, $options: 'i' } }];
    }
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const tickets = await Ticket.find(filter).populate('createdBy', 'name email').populate('assignedTo', 'name email').populate('assignedBy', 'name email').populate('departmentId', 'name').sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit));
    const escalatedTickets = [];
    for (const ticket of tickets) {
      escalatedTickets.push(await checkAndEscalateTicket(ticket));
    }
    const total = await Ticket.countDocuments(filter);
    return res.json({ tickets: escalatedTickets, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) { next(err); }
};
export const getDepartmentTickets = async (req, res, next) => {
  try {
    const user = req.user;
    const { status, priority, page = 1, limit = 10 } = req.query;
    if (!user.departmentId) return res.status(403).json({ message: 'Manager has no department assigned' });
    const filter = { departmentId: user.departmentId, ...(status ? { status } : {}), ...(priority ? { priority } : {}) };
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const tickets = await Ticket.find(filter).populate('createdBy', 'name email').populate('assignedTo', 'name email').populate('assignedBy', 'name email').populate('departmentId', 'name').sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit));
    const escalatedTickets = [];
    for (const ticket of tickets) {
      escalatedTickets.push(await checkAndEscalateTicket(ticket));
    }
    const total = await Ticket.countDocuments(filter);
    return res.json({ tickets: escalatedTickets, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) { next(err); }
};
export const getDepartmentTicket = async (req, res, next) => {
  try {
    const user = req.user;
    if (!user.departmentId) return res.status(403).json({ message: 'Manager has no department assigned' });
    const ticket = await Ticket.findOne({ _id: req.params.id, departmentId: user.departmentId }).populate('createdBy', 'name email').populate('assignedTo', 'name email').populate('assignedBy', 'name email').populate('departmentId', 'name');
    if (!ticket) return res.status(404).json({ message: 'Ticket not found or out of scope' });
    const escalated = await checkAndEscalateTicket(ticket);
    return res.json(escalated);
  } catch (err) { next(err); }
};
export const assignTicket = async (req, res, next) => {
  try {
    const user = req.user;
    const { assignedTo } = req.body;
    if (!assignedTo) return res.status(400).json({ message: 'assignedTo is required' });
    const permissions = user.role?.permissions || [];
    const roleName = user.role?.name;
    if (!permissions.includes('*') && roleName !== 'technical_manager') {
      return res.status(403).json({ message: 'Only technical_manager can assign' });
    }
    if (!user.departmentId) return res.status(403).json({ message: 'Manager has no department assigned' });
    const ticket = await Ticket.findOne({ _id: req.params.id, departmentId: user.departmentId });
    if (!ticket) return res.status(404).json({ message: 'Ticket not found or out of scope' });
    if (ticket.status === 'resolved' || ticket.status === 'closed') return res.status(400).json({ message: `Cannot assign a ticket that is ${ticket.status}` });
    const assignee = await User.findById(assignedTo).populate('role');
    if (!assignee) return res.status(400).json({ message: 'Assignee not found' });
    if (!assignee.departmentId || assignee.departmentId.toString() !== user.departmentId.toString()) return res.status(403).json({ message: 'Assignee must be in the same department' });
    const oldStatus = ticket.status;
    const oldAssignedTo = ticket.assignedTo;
    ticket.assignedTo = assignedTo;
    ticket.assignedBy = user._id;
    ticket.status = 'assigned';
    ticket.updatedAt = new Date();
    await ticket.save();
    await recordStatusChange(ticket._id, oldStatus, 'assigned', user._id, 'Ticket assigned by manager');
    if (oldAssignedTo && oldAssignedTo.toString() !== assignedTo) await recordFieldChange(ticket._id, 'assignedTo', oldAssignedTo, assignedTo, user._id, 'Assignee changed');
    await auditLog({ actor: user._id, action: 'ticket:assign', target: ticket, targetType: 'Ticket', targetId: ticket._id, outcome: 'success', details: { ticketNumber: ticket.ticketNumber, assignedTo, oldStatus }, req });
    return res.json(ticket);
  } catch (err) { next(err); }
};
export const getTeamTickets = async (req, res, next) => {
  try {
    const user = req.user;
    const { status, page = 1, limit = 10 } = req.query;
    const filter = { assignedTo: user._id, ...(status ? { status } : {}) };
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const tickets = await Ticket.find(filter).populate('createdBy', 'name email').populate('assignedTo', 'name email').populate('assignedBy', 'name email').populate('departmentId', 'name').sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit));
    const escalatedTickets = [];
    for (const ticket of tickets) {
      escalatedTickets.push(await checkAndEscalateTicket(ticket));
    }
    const total = await Ticket.countDocuments(filter);
    return res.json({ tickets: escalatedTickets, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) { next(err); }
};
export const updateStatus = async (req, res, next) => {
  try {
    const user = req.user;
    const { status, comment, faultDescription, resolutionType, partsRequired } = req.body;
    if (!status) return res.status(400).json({ message: 'status is required' });

    // Require faultDescription for specific statuses
    const requiresFaultDescription = ['partially_resolved', 'waiting_for_parts', 'on_hold'].includes(status);
    if (requiresFaultDescription && !faultDescription) {
      return res.status(400).json({ message: `faultDescription is required when setting status to ${status}` });
    }

    const ticket = await Ticket.findOne({ _id: req.params.id, assignedTo: user._id });
    if (!ticket) return res.status(404).json({ message: 'Ticket not found or not assigned to you' });

    const oldStatus = ticket.status;
    const allowed = TEAM_MEMBER_ALLOWED_TRANSITIONS[oldStatus];
    if (!allowed || !allowed.includes(status)) return res.status(400).json({ message: `Invalid transition from ${oldStatus} to ${status}` });
    if (status === 'closed') return res.status(400).json({ message: 'Use close endpoint to close a ticket' });

    ticket.status = status;
    ticket.updatedAt = new Date();

    if (faultDescription !== undefined) ticket.faultDescription = faultDescription.trim();
    if (resolutionType !== undefined) ticket.resolutionType = resolutionType;
    if (partsRequired !== undefined) ticket.partsRequired = partsRequired;

    await ticket.save();

    const noteParts = [comment || `Status changed to ${status}`];
    if (faultDescription) noteParts.push(`Fault: ${faultDescription}`);
    if (partsRequired) noteParts.push(`Parts needed: ${partsRequired.partName} x${partsRequired.quantity}`);
    if (resolutionType) noteParts.push(`Resolution: ${resolutionType}`);
    await recordStatusChange(ticket._id, oldStatus, status, user._id, noteParts.join('; '));

    await auditLog({
      actor: user._id,
      action: 'ticket:update_status',
      target: ticket,
      targetType: 'Ticket',
      targetId: ticket._id,
      outcome: 'success',
      details: {
        ticketNumber: ticket.ticketNumber,
        oldStatus,
        newStatus: status,
        comment,
        faultDescription,
        resolutionType,
        partsRequired
      },
      req
    });

    return res.json(ticket);
  } catch (err) { next(err); }
};
export const createTicket = async (req, res, next) => {
  try {
    const user = req.user;
    const { subject, departmentId, description, priority, customerName, customerPhone, customerEmail } = req.body;
    if (!subject) return res.status(400).json({ message: 'subject is required' });
    if (!departmentId) return res.status(400).json({ message: 'departmentId is required' });
    const dept = await Department.findById(departmentId);
    if (!dept) return res.status(400).json({ message: 'Invalid department ID' });

    let ticket;
    const maxRetries = 5;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const ticketNumber = `TKT-${Math.floor(100000 + Math.random() * 900000)}`;
      try {
        ticket = await Ticket.create({
          ticketNumber, subject, description, customerName, customerPhone, customerEmail, departmentId,
          priority: priority || 'medium', status: 'open', createdBy: user._id
        });
        break; // success
      } catch (err) {
        if (err.code === 11000 && attempt < maxRetries - 1) continue; // duplicate key, retry
        throw err; // re-throw if not duplicate or out of retries
      }
    }

    await auditLog({ actor: user._id, action: 'ticket:create', target: ticket, targetType: 'Ticket', targetId: ticket._id, outcome: 'success', details: { ticketNumber: ticket.ticketNumber, subject, departmentId }, req });
    return res.status(201).json(ticket);
  } catch (err) { next(err); }
};
export const getTicket = async (req, res, next) => {
  try {
    const user = req.user;
    const ticket = await Ticket.findById(req.params.id).populate('createdBy', 'name email').populate('assignedTo', 'name email').populate('assignedBy', 'name email').populate('departmentId', 'name');
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    if (!ticketInScope(user, ticket)) return res.status(404).json({ message: 'Ticket not found' });
    const escalated = await checkAndEscalateTicket(ticket);
    return res.json(escalated);
  } catch (err) { next(err); }
};
export const editTicket = async (req, res, next) => {
  try {
    const user = req.user;
    const { subject, description, priority, customerName, customerPhone, customerEmail } = req.body;
    const ticket = await Ticket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    if (!ticketInScope(user, ticket)) return res.status(404).json({ message: 'Ticket not found' });
    const permissions = user.role?.permissions || [];
    if (ticket.status === 'closed' && !permissions.includes('*')) return res.status(403).json({ message: 'Cannot edit a closed ticket' });
    const editableFields = ['subject', 'description', 'priority', 'customerName', 'customerPhone', 'customerEmail'];
    const changes = {};
    for (const field of editableFields) {
      if (req.body[field] !== undefined && req.body[field] !== ticket[field]) {
        changes[field] = { oldValue: ticket[field], newValue: req.body[field] };
        ticket[field] = req.body[field];
      }
    }
    if (Object.keys(changes).length === 0) return res.json(ticket);
    ticket.updatedAt = new Date();
    await ticket.save();
    for (const [field, change] of Object.entries(changes)) await recordFieldChange(ticket._id, field, change.oldValue, change.newValue, user._id, `Field ${field} updated`);
    await auditLog({ actor: user._id, action: 'ticket:edit', target: ticket, targetType: 'Ticket', targetId: ticket._id, outcome: 'success', details: { ticketNumber: ticket.ticketNumber, changedFields: Object.keys(changes) }, req });
    return res.json(ticket);
  } catch (err) { next(err); }
};
export const getTicketHistory = async (req, res, next) => {
  try {
    const user = req.user;
    const ticket = await Ticket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    if (!ticketInScope(user, ticket)) return res.status(404).json({ message: 'Ticket not found' });
    const history = await TicketHistory.find({ ticketId: req.params.id }).populate('changedBy', 'name email').sort({ createdAt: -1 });
    return res.json(history);
  } catch (err) { next(err); }
};
export const getTicketComments = async (req, res, next) => {
  try {
    const user = req.user;
    const ticket = await Ticket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    if (!ticketInScope(user, ticket)) return res.status(404).json({ message: 'Ticket not found' });
    const comments = await TicketComment.find({ ticketId: req.params.id }).populate('author', 'name email').sort({ createdAt: 1 });
    return res.json(comments);
  } catch (err) { next(err); }
};
export const addTicketComment = async (req, res, next) => {
  try {
    const user = req.user;
    const { comment, isInternalNote } = req.body;
    if (!comment || comment.trim() === '') return res.status(400).json({ message: 'comment must be non-empty' });
    const ticket = await Ticket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    if (!ticketInScope(user, ticket)) return res.status(404).json({ message: 'Ticket not found' });
    const newComment = await TicketComment.create({ ticketId: req.params.id, author: user._id, comment: comment.trim(), isInternalNote: isInternalNote === true });
    await newComment.populate('author', 'name email');
    await auditLog({ actor: user._id, action: 'ticket:comment', target: ticket, targetType: 'Ticket', targetId: ticket._id, outcome: 'success', details: { ticketNumber: ticket.ticketNumber, isInternalNote: newComment.isInternalNote }, req });
    return res.status(201).json(newComment);
  } catch (err) { next(err); }
};
export const closeTicket = async (req, res, next) => {
  try {
    const user = req.user;
    const ticket = await Ticket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    const permissions = user.role?.permissions || [];
    const roleName = user.role?.name;
    if (permissions.includes('*')) {
      // admin can close from any status
    } else {
      if (ticket.status !== 'resolved') return res.status(400).json({ message: 'Ticket must be resolved before closing' });
      if (roleName === 'technical_manager') {
        if (!ticketInScope(user, ticket)) return res.status(404).json({ message: 'Ticket not found' });
      } else if (roleName === 'service_engineer') {
        if (ticket.assignedTo?.toString() !== user._id.toString()) return res.status(403).json({ message: 'You must be the assigned engineer to close this ticket' });
      } else {
        return res.status(403).json({ message: 'Only technical_manager or assigned service_engineer can close this ticket' });
      }
    }
    ticket.status = 'closed';
    ticket.closedAt = new Date();
    ticket.updatedAt = new Date();
    await ticket.save();
    await recordStatusChange(ticket._id, 'resolved', 'closed', user._id, 'Ticket closed');
    await auditLog({ actor: user._id, action: 'ticket:close', target: ticket, targetType: 'Ticket', targetId: ticket._id, outcome: 'success', details: { ticketNumber: ticket.ticketNumber, closedAt: ticket.closedAt }, req });
    return res.json(ticket);
  } catch (err) { next(err); }
};