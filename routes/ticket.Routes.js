import express from 'express';

import {
  createTicket,
  getAllTickets,
  getDepartmentTickets,
  getDepartmentTicket,
  assignTicket,
  getTeamTickets,
  updateStatus,
  getTicket,
  editTicket,
  getTicketHistory,
  getTicketComments,
  addTicketComment,
  closeTicket
} from '../controller/ticket.controller.js';

import { authenticate, requirePermission } from '../middlewares/auth.js';

const router = express.Router();

// All ticket routes require authentication
router.use(authenticate);

// IMPORTANT: Route order matters. /manager, /manager/:id, /team, /all must be above /:id
// so Express does not treat them as ticket IDs.

// GET /manager - tickets in manager's department
router.get('/manager', requirePermission('ticket:view_department'), getDepartmentTickets);

// GET /manager/:id - one ticket in manager's department
router.get('/manager/:id', requirePermission('ticket:view_department'), getDepartmentTicket);

// POST /manager/:id/assign - assign ticket
router.post('/manager/:id/assign', requirePermission('ticket:assign'), assignTicket);

// GET /team - tickets assigned to me
router.get('/team', requirePermission('ticket:view_assigned'), getTeamTickets);

// PATCH /team/:id/status - update ticket status
router.patch('/team/:id/status', requirePermission('ticket:update_status'), updateStatus);

// GET /all - every ticket the user can see
router.get('/all', requirePermission('ticket:view'), getAllTickets);

// POST / - create a ticket
router.post('/', requirePermission('ticket:create'), createTicket);

// GET /:id - ticket detail
router.get('/:id', requirePermission('ticket:view'), getTicket);

// PATCH /:id - edit ticket fields
router.patch('/:id', requirePermission('ticket:edit'), editTicket);

// GET /:id/history - merged status and field history
router.get('/:id/history', requirePermission('ticket:view'), getTicketHistory);

// GET /:id/comments - comments oldest first
router.get('/:id/comments', requirePermission('ticket:view'), getTicketComments);

// POST /:id/comments - add comment
router.post('/:id/comments', requirePermission('ticket:comment'), addTicketComment);

// POST /:id/close - close a resolved ticket
router.post('/:id/close', requirePermission('ticket:close'), closeTicket);

export default router;