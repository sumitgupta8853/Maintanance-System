
import Role from '../Models/Role.js';
import { auditLog } from '../utils/audit.js';

// GET /api/permissions - list all unique permissions across all roles (catalog)
export const listPermissions = async (req, res, next) => {
  try {
    const roles = await Role.find({}, 'permissions name').sort({ name: 1 });

    const permissionSet = new Set();
    roles.forEach((role) => {
      (role.permissions || []).forEach((p) => permissionSet.add(p));
    });

    return res.json({
      permissions: Array.from(permissionSet).sort(),
      total: permissionSet.size,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/permissions/roles - list all roles with their permissions
export const listRolesWithPermissions = async (req, res, next) => {
  try {
    const roles = await Role.find({}, 'name description permissions isSystem').sort({ name: 1 });
    return res.json(roles);
  } catch (err) {
    next(err);
  }
};

// POST /api/permissions/roles/:roleId/grant - add permissions to a role
export const grantPermissions = async (req, res, next) => {
  try {
    const { permissions } = req.body;

    if (!Array.isArray(permissions) || permissions.length === 0) {
      return res.status(400).json({
        message: 'permissions must be a non-empty array',
      });
    }

    const role = await Role.findById(req.params.roleId);

    if (!role) {
      return res.status(404).json({ message: 'Role not found' });
    }

    // Block non-admin from granting wildcard permission
    if (permissions.includes('*') && (!req.user || !req.user.role || req.user.role.name !== 'admin')) {
      await auditLog({
        actor: req.user._id,
        action: 'permission:grant',
        target: role,
        targetType: 'Role',
        targetId: role._id,
        outcome: 'failure',
        details: { granted: permissions, reason: 'non-admin cannot grant wildcard permission' },
        req,
      });
      return res.status(403).json({ message: 'Forbidden: only admins can grant wildcard permission' });
    }

    const existing = new Set(role.permissions || []);
    permissions.forEach((p) => existing.add(p));

    role.permissions = Array.from(existing);
    await role.save();

    await auditLog({
      actor: req.user._id,
      action: 'permission:grant',
      target: role,
      targetType: 'Role',
      targetId: role._id,
      outcome: 'success',
      details: { granted: permissions, previousPermissions: role.permissions },
      req,
    });

    return res.json({
      message: 'Permissions granted',
      role: {
        id: role._id,
        name: role.name,
        permissions: role.permissions,
      },
    });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/permissions/roles/:roleId/revoke/:permission - remove a permission
export const revokePermission = async (req, res, next) => {
  try {
    const role = await Role.findById(req.params.roleId);

    if (!role) {
      return res.status(404).json({ message: 'Role not found' });
    }

    const permission = req.params.permission;

    if (!role.permissions || !role.permissions.includes(permission)) {
      return res.status(404).json({
        message: `Permission '${permission}' not found on role`,
      });
    }

    role.permissions = role.permissions.filter((p) => p !== permission);
    await role.save();

    await auditLog({
      actor: req.user._id,
      action: 'permission:revoke',
      target: role,
      targetType: 'Role',
      targetId: role._id,
      outcome: 'success',
      details: { revoked: permission },
      req,
    });

    return res.json({
      message: 'Permission revoked',
      role: {
        id: role._id,
        name: role.name,
        permissions: role.permissions,
      },
    });
  } catch (err) {
    next(err);
  }
};

// PUT /api/permissions/roles/:roleId/set - replace permissions array
export const setPermissions = async (req, res, next) => {
  try {
    const { permissions } = req.body;

    if (!Array.isArray(permissions)) {
      return res.status(400).json({
        message: 'permissions must be an array',
      });
    }

    const role = await Role.findById(req.params.roleId);

    if (!role) {
      return res.status(404).json({ message: 'Role not found' });
    }

    // Block non-admin from setting wildcard permission
    if (permissions.includes('*') && (!req.user || !req.user.role || req.user.role.name !== 'admin')) {
      await auditLog({
        actor: req.user._id,
        action: 'permission:set',
        target: role,
        targetType: 'Role',
        targetId: role._id,
        outcome: 'failure',
        details: { permissions, reason: 'non-admin cannot set wildcard permission' },
        req,
      });
      return res.status(403).json({ message: 'Forbidden: only admins can set wildcard permission' });
    }

    role.permissions = permissions;
    await role.save();

    await auditLog({
      actor: req.user._id,
      action: 'permission:set',
      target: role,
      targetType: 'Role',
      targetId: role._id,
      outcome: 'success',
      details: { permissions },
      req,
    });

    return res.json({
      message: 'Permissions updated',
      role: {
        id: role._id,
        name: role.name,
        permissions: role.permissions,
      },
    });
  } catch (err) {
    next(err);
  }
};
