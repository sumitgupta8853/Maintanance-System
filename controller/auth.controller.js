import User from '../Models/User.js';
import RefreshToken from '../Models/RefreshToken.js';
import {
    hash,
    signAccessToken,
    issueRefreshToken,
    verifyRefreshToken,
} from '../utils/Token.js';

// If a token was revoked less than this long ago, treat a second use as a
// harmless concurrent request (e.g. two tabs), not as token theft.
const REUSE_GRACE_MS = Number(process.env.REFRESH_REUSE_GRACE_MS) || 15 * 1000;

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

        const user = await User.findOne({ email: email.toLowerCase() })
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

        // 1. Verify signature and expiry
        let payload;
        try {
            payload = verifyRefreshToken(refreshToken);
        } catch {
            return res.status(401).json({
                message: 'Invalid or expired refresh token',
            });
        }

        const tokenHash = hash(refreshToken);

        // 2. Atomically revoke the token. Only one concurrent request can win.
        const stored = await RefreshToken.findOneAndUpdate(
            { tokenHash, revokedAt: null },
            { $set: { revokedAt: new Date() } }
        );

        // 3. Not active: decide between "unknown", "race", or "reuse"
        if (!stored) {
            const existing = await RefreshToken.findOne({ tokenHash });

            // Unknown or already cleaned up (expired, logged out and purged)
            if (!existing) {
                return res.status(401).json({
                    message: 'Invalid refresh token. Please log in again.',
                });
            }

            const age = Date.now() - existing.revokedAt.getTime();

            // Used a moment ago: most likely a concurrent request from the
            // same client. Do not punish the user; client should retry with
            // the newest token it received.
            if (age <= REUSE_GRACE_MS) {
                return res.status(409).json({
                    message: 'Refresh already in progress. Retry shortly.',
                });
            }

            // Used long ago and presented again: likely stolen token.
            await RefreshToken.deleteMany({ user: existing.user });
            return res.status(401).json({
                message: 'Refresh token reuse detected. Please log in again.',
            });
        }

        // 4. Load the user from the DB record, not the JWT claim
        const user = await User.findById(stored.user).populate('role');

        if (!user || !user.isActive) {
            return res.status(401).json({
                message: 'User not found or deactivated',
            });
        }

        // 5. Issue the new pair
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
            await RefreshToken.deleteOne({ tokenHash: hash(refreshToken) });
        }

        return res.json({ message: 'Logged out' });
    } catch (err) {
        next(err);
    }
};

// Log out all devices
export const logoutAll = async (req, res, next) => {
    try {
        await RefreshToken.deleteMany({ user: req.user._id });

        return res.json({ message: 'Logged out from all devices' });
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