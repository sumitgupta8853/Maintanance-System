import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import RefreshToken from '../Models/RefreshToken.js';

const ALGORITHM = 'HS256';
const MAX_SESSIONS_PER_USER = Number(process.env.MAX_SESSIONS_PER_USER) || 5;

// Hash the token before storing it in MongoDB
export const hash = (token) =>
    crypto.createHash('sha256').update(token).digest('hex');

// Short-lived token: sent with every API request
// NOTE: user.role must be populated
export const signAccessToken = (user) =>
    jwt.sign(
        { id: user._id, role: user.role.name },
        process.env.JWT_ACCESS_SECRET,
        {
            algorithm: ALGORITHM,
            expiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || '1m',
        }
    );

export const verifyAccessToken = (token) =>
    jwt.verify(token, process.env.JWT_ACCESS_SECRET, {
        algorithms: [ALGORITHM],
    });

export const verifyRefreshToken = (token) =>
    jwt.verify(token, process.env.JWT_REFRESH_SECRET, {
        algorithms: [ALGORITHM],
    });

// Long-lived token: used to generate a new access token
export const issueRefreshToken = async (user) => {
    const token = jwt.sign(
        { id: user._id, jti: crypto.randomUUID() },
        process.env.JWT_REFRESH_SECRET,
        {
            algorithm: ALGORITHM,
            expiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '7d',
        }
    );

    const { exp } = jwt.decode(token);

    await RefreshToken.create({
        user: user._id,
        tokenHash: hash(token),
        expiresAt: new Date(exp * 1000),
    });

    // Enforce a cap on active sessions: remove the oldest extras
    const active = await RefreshToken.find({
        user: user._id,
        revokedAt: null,
    })
        .sort({ createdAt: -1 })
        .skip(MAX_SESSIONS_PER_USER)
        .select('_id');

    if (active.length) {
        await RefreshToken.deleteMany({
            _id: { $in: active.map((t) => t._id) },
        });
    }

    return token;
};