import express from 'express';

import {
  registerDevice,
  unregisterDevice,
  listMyDevices,
  sendNotification,
} from '../controller/notification.controller.js';

import { authenticate, requirePermission } from '../middlewares/auth.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Register / update the current user's FCM device token
router.post('/register-device', registerDevice);

// Deactivate / remove a device token for the current user
router.delete('/unregister-device', unregisterDevice);

// List the current user's active devices
router.get('/devices', listMyDevices);

// Admin-only: send a push notification (to user / topic / tokens)
// Requires permission: notification:send
router.post('/send', requirePermission('notification:send'), sendNotification);

export default router;
