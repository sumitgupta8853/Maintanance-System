import Department from '../Models/Department.js';
import { auditLog } from '../utils/audit.js';
import Role from '../Models/Role.js';
import User from '../Models/User.js';

export const createDepartment = async (req, res, next) => {
  try {
    const { name, description } = req.body;

    const department = await Department.create({
      name,
      description,
    });

    await auditLog({
      actor: req.user._id,
      action: 'department:create',
      target: department,
      targetType: 'Department',
      targetId: department._id,
      outcome: 'success',
      details: { name, description },
      req,
    });

    return res.status(201).json(department);
  } catch (err) {
    next(err);
  }
};

export const getDepartments = async (req, res, next) => {
  try {
    const departments = await Department.find().sort({ name: 1 }).lean();

    const [roleCounts, userCounts] = await Promise.all([
      Role.aggregate([{ $group: { _id: '$departmentId', count: { $sum: 1 } } }]),
      User.aggregate([{ $group: { _id: '$departmentId', count: { $sum: 1 } } }]),
    ]);

    const toMap = (rows) => new Map(rows.map((r) => [String(r._id), r.count]));
    const roles = toMap(roleCounts);
    const users = toMap(userCounts);

    return res.json(
      departments.map((d) => ({
        ...d,
        roleCount: roles.get(String(d._id)) || 0,
        userCount: users.get(String(d._id)) || 0,
      }))
    );
  } catch (err) {
    next(err);
  }
};

export const getDepartment = async (req, res, next) => {
  try {
    const department = await Department.findById(req.params.id).lean();

    if (!department) {
      return res.status(404).json({ message: 'Department not found' });
    }

    const [roles, users] = await Promise.all([
      Role.find({ departmentId: department._id }).sort({ name: 1 }).lean(),
      User.find({ departmentId: department._id })
        .select('name email role isActive')
        .populate('role', 'name')
        .sort({ name: 1 })
        .lean(),
    ]);

    return res.json({ ...department, roles, users });
  } catch (err) {
    next(err);
  }
};

export const updateDepartment = async (req, res, next) => {
  try {
    const department = await Department.findById(req.params.id);

    if (!department) {
      return res.status(404).json({
        message: 'Department not found',
      });
    }

    const { name, description } = req.body;

    if (name !== undefined) department.name = name;
    if (description !== undefined) department.description = description;

    await department.save();

    await auditLog({
      actor: req.user._id,
      action: 'department:update',
      target: department,
      targetType: 'Department',
      targetId: department._id,
      outcome: 'success',
      details: { changedFields: Object.keys(req.body) },
      req,
    });

    return res.json(department);
  } catch (err) {
    next(err);
  }
};

export const deleteDepartment = async (req, res, next) => {
  try {
    const department = await Department.findById(req.params.id);

    if (!department) {
      return res.status(404).json({
        message: 'Department not found',
      });
    }

    const inUse = await Department.countDocuments({ _id: department._id });

    await department.deleteOne();

    await auditLog({
      actor: req.user._id,
      action: 'department:delete',
      targetType: 'Department',
      targetId: department._id,
      outcome: 'success',
      details: { name: department.name },
      req,
    });

    return res.json({
      message: 'Department deleted',
    });
  } catch (err) {
    next(err);
  }
};