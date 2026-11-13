import User from '../Models/User.js';
import { verifyAccessToken } from '../utils/Token.js';

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
        code: 'NO_TOKEN',
      });
    }

    let payload;

    try {
      payload = verifyAccessToken(token);
    } catch (err) {
      return res.status(401).json({
        message:
          err.name === 'TokenExpiredError'
            ? 'Access token expired'
            : 'Invalid token',
        code:
          err.name === 'TokenExpiredError'
            ? 'TOKEN_EXPIRED'
            : 'TOKEN_INVALID',

      });
    }

    const user = await User.findById(payload.id).populate('role');

    if (!user || !user.isActive) {
      return res.status(401).json({
        message: 'User not found or deactivated',
        code: 'USER_INACTIVE',
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
  if (!req.user) {
    return res.status(401).json({
      message: 'Authentication required',
      code: 'NO_TOKEN',
    });
  }

  const roleName = req.user.role?.name;

  if (!roleName || !roles.includes(roleName)) {
    return res.status(403).json({

      message: 'Forbidden: insufficient role',
    });
  }

  next();
};

// Check role permissions; "*" grants all permissions
export const requirePermission = (...perms) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      message: 'Authentication required',
      code: 'NO_TOKEN',
    });
  }

  const granted = req.user.role?.permissions || [];

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