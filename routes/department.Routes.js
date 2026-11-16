import express from 'express';

import {
    createDepartment,
    getDepartments,
    getDepartment,
    updateDepartment,
    deleteDepartment,
} from '../controller/department.controller.js';

import {
    authenticate,
    requirePermission,
} from '../middlewares/auth.js';

const router = express.Router();

// Read routes: department:view (admin via * wildcard, Technical Manager via explicit grant)
router.get('/', authenticate, requirePermission('department:view'), getDepartments);
router.get('/:id', authenticate, requirePermission('department:view'), getDepartment);

// Management routes require department:manage permission (admin via * wildcard)
router.post('/', authenticate, requirePermission('department:manage'), createDepartment);
router.put('/:id', authenticate, requirePermission('department:manage'), updateDepartment);
router.delete('/:id', authenticate, requirePermission('department:manage'), deleteDepartment);

export default router;