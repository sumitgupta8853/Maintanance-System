
import Role from '../Models/Role.js';
import User from '../Models/User.js';
import Department from '../Models/Department.js';
import { auditLog } from '../utils/audit.js';

export const createRole = async (req, res, next) => {
  try {
    const { name, description, permissions, departmentId } = req.body;

    // Block non-admin from creating roles with wildcard permission
    if (permissions && permissions.includes('*') && (!req.user || !req.user.role || req.user.role.name !== 'admin')) {
      await auditLog({
        actor: req.user._id,
        action: 'role:create',
        targetType: 'Role',
        outcome: 'failure',
        details: { name, reason: 'non-admin cannot create role with wildcard permission' },
        req,
      });
      return res.status(403).json({ message: 'Forbidden: only admins can create roles with wildcard permission' });
    }

    // Validate department ID exists if provided
    let targetDepartment;
    if (departmentId !== undefined && departmentId !== null) {
      targetDepartment = await Department.findById(departmentId);
      if (!targetDepartment) {
        return res.status(400).json({ message: 'Invalid department ID' });
      }
    }

    const role = await Role.create({
      name,
      description,
      permissions,
      departmentId,
    });

    await auditLog({
      actor: req.user._id,
      action: 'role:create',
      target: role,
      targetType: 'Role',
      targetId: role._id,
      outcome: 'success',
      details: { name, description, permissions, department: targetDepartment ? targetDepartment.name : null },
      req,
    });

    return res.status(201).json(role);
  } catch (err) {
    next(err);
  }
};

export const getRoles = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.departmentId) filter.departmentId = req.query.departmentId;

    return res.json(await Role.find(filter).sort({ name: 1 }).populate('departmentId'));
  } catch (err) {
    next(err);
  }
};

export const getRole = async (req, res, next) => {
  try {
    const role = await Role.findById(req.params.id).populate('departmentId');

    if (!role) {
      return res.status(404).json({
        message: 'Role not found',
      });
    }

    return res.json(role);
  } catch (err) {
    next(err);
  }
};

export const updateRole = async (req, res, next) => {
  try {
    const role = await Role.findById(req.params.id);

    if (!role) {
      return res.status(404).json({
        message: 'Role not found',
      });
    }

    const { name, description, permissions, departmentId } = req.body;

    if (
      role.isSystem &&
      name !== undefined &&
      name.toLowerCase() !== role.name.toLowerCase()
    ) {
      return res.status(400).json({
        message: 'System role cannot be renamed',
      });
    }

    if (name !== undefined) role.name = name;
    if (description !== undefined) role.description = description;
    if (permissions !== undefined) role.permissions = permissions;

    // Validate department ID exists if provided
    let targetDepartment;
    if (departmentId !== undefined) {
      if (departmentId === null) {
        role.departmentId = null;
      } else {
        targetDepartment = await Department.findById(departmentId);
        if (!targetDepartment) {
          return res.status(400).json({ message: 'Invalid department ID' });
        }
        role.departmentId = departmentId;
      }
    }

    // Block non-admin from granting wildcard permission
    if (permissions && permissions.includes('*') && (!req.user || !req.user.role || req.user.role.name !== 'admin')) {
      await auditLog({
        actor: req.user._id,
        action: 'role:update',
        target: role,
        targetType: 'Role',
        targetId: role._id,
        outcome: 'failure',
        details: { reason: 'non-admin cannot grant wildcard permission' },
        req,
      });
      return res.status(403).json({ message: 'Forbidden: only admins can grant wildcard permission' });
    }

    await role.save();

    await auditLog({
      actor: req.user._id,
      action: 'role:update',
      target: role,
      targetType: 'Role',
      targetId: role._id,
      outcome: 'success',
      details: {
        changedFields: Object.keys(req.body),
        department: targetDepartment ? targetDepartment.name : departmentId === null ? null : undefined,
      },
      req,
    });

    return res.json(role);
  } catch (err) {
    next(err);
  }
};

export const deleteRole = async (req, res, next) => {
  try {
    const role = await Role.findById(req.params.id);

    if (!role) {
      return res.status(404).json({
        message: 'Role not found',
      });
    }

    if (role.isSystem) {
      return res.status(400).json({
        message: 'System role cannot be deleted',
      });
    }

    const inUse = await User.countDocuments({
      role: role._id,
    });

    if (inUse > 0) {
      return res.status(409).json({
        message: `Role is assigned to ${inUse} user(s)`,
      });
    }

    await role.deleteOne();

    await auditLog({
      actor: req.user._id,
      action: 'role:delete',
      targetType: 'Role',
      targetId: role._id,
      outcome: 'success',
      details: { name: role.name },
      req,
    });

    return res.json({
      message: 'Role deleted',
    });
  } catch (err) {
    next(err);
  }
};
