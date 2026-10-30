
import User from '../Models/User.js';
import Role from '../Models/Role.js';
import Department from '../Models/Department.js';
import { auditLog } from '../utils/audit.js';

const PRIVILEGED_ROLES = ['admin', 'technical_manager'];

export const createUser = async (req, res, next) => {
  try {
    const { name, email, password, role, departmentId } = req.body;
    console.log('Create User Request Body:', req.body);
    // Validate role ID exists in MongoDB
    const targetRole = await Role.findById(role);
    console.log('Target Role:', targetRole);
    if (!targetRole) {
      return res.status(400).json({ message: 'Invalid role ID' });
    }

    // Validate department ID exists if provided
    let targetDepartment;
    if (departmentId !== undefined && departmentId !== null) {
      targetDepartment = await Department.findById(departmentId);
      if (!targetDepartment) {
        return res.status(400).json({ message: 'Invalid department ID' });
      }
    }

    // Technical managers can only create service engineers
    if (req.user && req.user.role && req.user.role.name === 'technical_manager') {
      if (targetRole.name !== 'service_engineer') {
        await auditLog({
          actor: req.user._id,
          action: 'user:create',
          targetType: 'Role',
          targetId: role,
          outcome: 'failure',
          details: { requestedRole: targetRole.name, reason: 'technical_manager cannot create non-service_engineer' },
          req,
        });
        return res.status(403).json({
          message: 'Forbidden: technical managers can only create service engineers',
        });
      }
    }

    const user = await User.create({
      name,
      email,
      password,
      role,
      departmentId,
    });

    await auditLog({
      actor: req.user._id,
      action: 'user:create',
      target: user,
      targetType: 'User',
      targetId: user._id,
      outcome: 'success',
      details: { role: targetRole.name, department: targetDepartment ? targetDepartment.name : null },
      req,
    });

    return res.status(201).json(user);
  } catch (err) {
    next(err);
  }
};

export const getUsers = async (req, res, next) => {
  try {
    // Admins can view all users; department managers can only view their own department users
    if (req.user && req.user.role && req.user.role.name === 'admin') {
      return res.json(
        await User.find()
          .sort({ name: 1 })
          .populate('role')
          .populate('departmentId')
      );
    }

    // For other roles (e.g., technical_manager), filter by the user's department
    const userDepartmentId = req.user?.departmentId;
    if (userDepartmentId) {
      return res.json(
        await User.find({ departmentId: userDepartmentId })
          .sort({ name: 1 })
          .populate('role')
          .populate('departmentId')
      );
    }

    // If no department is set, return empty result
    return res.json([]);
  } catch (err) {
    next(err);
  }
};

export const updateUser = async (req, res, next) => {
  try {
    const { role, isActive, departmentId, ...rest } = req.body;
    const updates = { ...rest };

    // Validate role ID exists if present
    let targetRole;
    if (role !== undefined) {
      targetRole = await Role.findById(role);
      if (!targetRole) {
        return res.status(400).json({ message: 'Invalid role ID' });
      }
      updates.role = role;
    }

    // Validate department ID exists if present
    let targetDepartment;
    if (departmentId !== undefined) {
      if (departmentId === null) {
        updates.departmentId = null;
      } else {
        targetDepartment = await Department.findById(departmentId);
        if (!targetDepartment) {
          return res.status(400).json({ message: 'Invalid department ID' });
        }
        updates.departmentId = departmentId;
      }
    }

    if (isActive !== undefined) {
      updates.isActive = isActive;
    }

    // Prevent self role-change
    if (role !== undefined && req.user && req.user._id.toString() === req.params.id) {
      return res.status(403).json({
        message: 'Forbidden: you cannot change your own role',
      });
    }

    // Block non-admin from assigning privileged roles
    if (role !== undefined && targetRole && PRIVILEGED_ROLES.includes(targetRole.name)) {
      if (!req.user || !req.user.role || req.user.role.name !== 'admin') {
        await auditLog({
          actor: req.user._id,
          action: 'user:update',
          targetId: req.params.id,
          targetType: 'User',
          outcome: 'failure',
          details: { attemptedRole: targetRole.name, reason: 'non-admin cannot assign privileged role' },
          req,
        });
        return res.status(403).json({
          message: 'Forbidden: only admins can assign privileged roles',
        });
      }
    }

    const user = await User.findByIdAndUpdate(req.params.id, { $set: updates }, {
      new: true,
      runValidators: true,
    }).populate('role').populate('departmentId');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    await auditLog({
      actor: req.user._id,
      action: 'user:update',
      target: user,
      targetType: 'User',
      targetId: user._id,
      outcome: 'success',
      details: {
        changedFields: Object.keys(updates),
        role: targetRole ? targetRole.name : undefined,
        department: targetDepartment ? targetDepartment.name : departmentId === null ? null : undefined,
        isActive: updates.isActive,
      },
      req,
    });

    return res.json(user);
  } catch (err) {
    next(err);
  }
};

export const deleteUser = async (req, res, next) => {
  try {
    // Prevent self-deletion
    if (req.user && req.user._id.toString() === req.params.id) {
      return res.status(403).json({
        message: 'Forbidden: you cannot delete your own account',
      });
    }

    const user = await User.findByIdAndDelete(req.params.id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    await auditLog({
      actor: req.user._id,
      action: 'user:delete',
      targetType: 'User',
      targetId: user._id,
      outcome: 'success',
      details: { deletedUser: { name: user.name, email: user.email, role: user.role } },
      req,
    });

    return res.json({ message: 'User deleted' });
  } catch (err) {
    next(err);
  }
};
