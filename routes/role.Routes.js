
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

// Role management requires role:manage permission (admin via * wildcard)
router.use(authenticate, requirePermission('role:manage'));

router.route('/')
    .post(createRole)
    .get(getRoles);

router.route('/:id')
    .get(getRole)
    .put(updateRole)
    .delete(deleteRole);

export default router;
