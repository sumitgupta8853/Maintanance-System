
import jwt from 'jsonwebtoken';
import User from '../Models/User.js';
import RefreshToken from '../Models/RefreshToken.js';
import {
    hash,
    signAccessToken,
    issueRefreshToken,
} from '../utils/Token.js';

const userPayload = (u) => ({
    id: u._id,
    name: u.name,
    email: u.email,
    role: u.role.name,
    permissions: u.role.permissions,
});

export const login = async (req, res, next) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                message: 'Email and password are required',
            });
        }

        const user = await User.findOne({
            email: email.toLowerCase(),
        })
            .select('+password')
            .populate('role');

        if (!user || !(await user.comparePassword(password))) {
            return res.status(401).json({
                message: 'Invalid email or password',
            });
        }

        if (!user.isActive) {
            return res.status(403).json({
                message: 'Account is deactivated',
            });
        }

        return res.json({
            accessToken: signAccessToken(user),
            refreshToken: await issueRefreshToken(user),
            user: userPayload(user),
        });
    } catch (err) {
        next(err);
    }
};

// Exchange a refresh token for a new access token and refresh token
export const refresh = async (req, res, next) => {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return res.status(400).json({
                message: 'refreshToken is required',
            });
        }

        let payload;

        try {
            payload = jwt.verify(
                refreshToken,
                process.env.JWT_REFRESH_SECRET
            );
        } catch {
            return res.status(401).json({
                message: 'Invalid or expired refresh token',
            });
        }

        // Consume the refresh token
        const stored = await RefreshToken.findOneAndDelete({
            tokenHash: hash(refreshToken),
        });

        if (!stored) {
            // A missing token may indicate reuse or revocation.
            await RefreshToken.deleteMany({ user: payload.id });

            return res.status(401).json({
                message: 'Refresh token reuse detected. Please log in again.',
            });
        }

        const user = await User.findById(payload.id)
            .populate('role');

        if (!user || !user.isActive) {
            return res.status(401).json({
                message: 'User not found or deactivated',
            });
        }

        return res.json({
            accessToken: signAccessToken(user),
            refreshToken: await issueRefreshToken(user),
        });
    } catch (err) {
        next(err);
    }
};

// Log out this device
export const logout = async (req, res, next) => {
    try {
        const { refreshToken } = req.body;

        if (refreshToken) {
            await RefreshToken.deleteOne({
                tokenHash: hash(refreshToken),
            });
        }

        return res.json({ message: 'Logged out' });
    } catch (err) {
        next(err);
    }
};

// Log out all devices
export const logoutAll = async (req, res, next) => {
    try {
        await RefreshToken.deleteMany({
            user: req.user._id,
        });

        return res.json({
            message: 'Logged out from all devices',
        });
    } catch (err) {
        next(err);
    }
};

// Get the current user's profile
export const me = (req, res, next) => {
    try {
        return res.json(userPayload(req.user));
    } catch (err) {
        next(err);
    }
};
