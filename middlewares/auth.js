
import jwt from 'jsonwebtoken';
import User from '../Models/User.js';

// Verify the Bearer token and attach the user to req.user
export const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ')
      ? header.slice(7)
      : null;

    if (!token) {
      return res.status(401).json({
        message: 'Authentication required',
      });
    }

    let payload;

    try {
      payload = jwt.verify(
        token,
        process.env.JWT_ACCESS_SECRET
      );
    } catch {
      return res.status(401).json({
        message: 'Invalid or expired token',
      });
    }

    const user = await User.findById(payload.id)
      .populate('role');

    if (!user || !user.isActive) {
      return res.status(401).json({
        message: 'User not found or deactivated',
      });
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
};

// Allow only specified role names
export const authorizeRoles = (...roles) => (req, res, next) => {
  const roleName = req.user?.role?.name;

  if (!roleName || !roles.includes(roleName)) {
    return res.status(403).json({
      message: 'Forbidden: insufficient role',
    });
  }

  next();
};

// Check role permissions; "*" grants all permissions
export const requirePermission = (...perms) => (req, res, next) => {
  const granted = req.user?.role?.permissions || [];

  if (
    granted.includes('*') ||
    perms.every((permission) => granted.includes(permission))
  ) {
    return next();
  }

  return res.status(403).json({
    message: 'Forbidden: missing permission',
  });
};
