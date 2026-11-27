import express from 'express';
import { upload } from '../utils/multer.js';

import {
    createUser,
    getUsers,
    updateUser,
    updateProfile,
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
    .get(requirePermission('users:view'), getUsers);

// Any logged-in user can edit their own profile (ownership checked in the controller)
router.put('/:id/profile', upload.single('photo'), updateProfile);

router.route('/:id')
    .put(requirePermission('users:update'), updateUser)
    .delete(requirePermission('users:delete'), deleteUser);


export default router;