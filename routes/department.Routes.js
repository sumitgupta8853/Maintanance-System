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

// Read routes: ticket:view (or just authenticate) so ticket creators can read departments
router.get('/', authenticate, requirePermission('ticket:view'), getDepartments);
router.get('/:id', authenticate, requirePermission('ticket:view'), getDepartment);

// Management routes require department:manage permission (admin via * wildcard)
router.post('/', authenticate, requirePermission('department:manage'), createDepartment);
router.put('/:id', authenticate, requirePermission('department:manage'), updateDepartment);
router.delete('/:id', authenticate, requirePermission('department:manage'), deleteDepartment);

export default router;