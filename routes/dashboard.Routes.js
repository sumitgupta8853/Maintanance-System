import express from 'express';

import {
  getDashboard,
  getSummary,
  getTicketStats,
  getTicketPriority,
  getTicketDepartment,
  getTicketTrend,
  getRecentTickets,
  getChargerHealth,
  getEngineers,
  getActivity
} from '../controller/dashboard.controller.js';

import { authenticate } from '../middlewares/auth.js';

const router = express.Router();

// Dashboard routes require authentication only (no permission checks)
router.use(authenticate);

router.get('/', getDashboard);
router.get('/summary', getSummary);
router.get('/tickets/stats', getTicketStats);
router.get('/tickets/priority', getTicketPriority);
router.get('/tickets/department', getTicketDepartment);
router.get('/tickets/trend', getTicketTrend);
router.get('/recent', getRecentTickets);
router.get('/charger-health', getChargerHealth);
router.get('/engineers', getEngineers);
router.get('/activity', getActivity);

export default router;
