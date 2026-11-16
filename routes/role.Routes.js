
import express from 'express';

import {
    createRole,
    getRoles,
    getRole,
    updateRole,
    deleteRole,
} from '../controller/role.controller.js';

import {
    authenticate,
    requirePermission,
} from '../middlewares/auth.js';

const router = express.Router();

// Role management: all routes require authentication.
// Write operations (POST/PUT/DELETE) require role:manage (admin via * wildcard).
// Read operations (GET) require role:view (admin via * wildcard, Technical Manager via explicit grant).
router.use(authenticate);

router.route('/')
    .post(requirePermission('role:manage'), createRole)
    .get(requirePermission('role:view'), getRoles);

router.route('/:id')
    .get(requirePermission('role:view'), getRole)
    .put(requirePermission('role:manage'), updateRole)
    .delete(requirePermission('role:manage'), deleteRole);

export default router;
