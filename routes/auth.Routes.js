import express from 'express';

import {
  login,
  refresh,
  logout,
  logoutAll,
  me
} from '../controller/auth.controller.js';

import {authenticate} from '../middlewares/auth.js';

const router = express.Router();

router.post('/login', login);
router.post('/refresh', refresh);
router.post('/logout', logout);
router.post('/logout-all', authenticate, logoutAll);
router.get('/me', authenticate, me);

export const authRoutes = router;