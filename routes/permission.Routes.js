
import express from 'express';

import {
  listPermissions,
  listRolesWithPermissions,
  grantPermissions,
  revokePermission,
  setPermissions,
} from '../controller/permission.controller.js';

import { authenticate, requirePermission } from '../middlewares/auth.js';

const router = express.Router();

// Permission management requires permission:manage permission (admin via * wildcard)
router.use(authenticate, requirePermission('permission:manage'));

// Catalog of all unique permissions across roles
router.get('/', listPermissions);

// All roles with their permissions
router.get('/roles', listRolesWithPermissions);

// Grant permissions to a role
router.post('/roles/:roleId/grant', grantPermissions);

// Revoke a single permission from a role
router.delete('/roles/:roleId/revoke/:permission', revokePermission);

// Replace a role's entire permissions array
router.put('/roles/:roleId/set', setPermissions);

export default router;
