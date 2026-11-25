import express from 'express';

import {
  sendOtp,
  verifyOtp,
  refresh,
  logout,
  logoutAll,
  me
} from '../controller/auth.controller.js';

import { authenticate } from '../middlewares/auth.js';

const router = express.Router();

// OTP-based login flow
router.post('/send-otp', sendOtp);
router.post('/verify-otp', verifyOtp);

router.post('/refresh', refresh);
router.post('/logout', logout);
router.post('/logout-all', authenticate, logoutAll);
router.get('/me', authenticate, me);

export const authRoutes = router; 