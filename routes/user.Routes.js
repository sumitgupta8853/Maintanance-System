
import express from 'express';

import {
    createUser,
    getUsers,
    updateUser,
    deleteUser,
} from '../controller/user.controller.js';

import {
    authenticate,
    requirePermission,
} from '../middlewares/auth.js';

const router = express.Router();

router.use(authenticate);

// Admin (*) and Technical Manager (users:create) can create users
router.route('/')
    .post(requirePermission('users:create'), createUser)
    .get(requirePermission('users:read'), getUsers);

router.route('/:id')
    .put(requirePermission('users:update'), updateUser)
    .delete(requirePermission('users:delete'), deleteUser);

export default router;
