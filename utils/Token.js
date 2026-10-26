
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import RefreshToken from '../Models/RefreshToken.js';

// Hash the token before storing it in MongoDB
export const hash = (token) =>
    crypto.createHash('sha256').update(token).digest('hex');

// Short-lived token: sent with every API request
export const signAccessToken = (user) =>
    jwt.sign(
        { id: user._id, role: user.role.name },
        process.env.JWT_ACCESS_SECRET,
        {
            expiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || '15m',
        }
    );

// Long-lived token: used to generate a new access token
export const issueRefreshToken = async (user) => {
    const token = jwt.sign(
        { id: user._id, jti: crypto.randomUUID() },
        process.env.JWT_REFRESH_SECRET,
        {
            expiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '7d',
        }
    );

    const { exp } = jwt.decode(token);

    await RefreshToken.create({
        user: user._id,
        tokenHash: hash(token),
        expiresAt: new Date(exp * 1000),
    });

    return token;
};
