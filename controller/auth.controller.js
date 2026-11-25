import User from '../Models/User.js';
import RefreshToken from '../Models/RefreshToken.js';
import Otp from '../Models/Otp.js';
import {
    hash,
    signAccessToken,
    issueRefreshToken,
    verifyRefreshToken,
} from '../utils/Token.js';
import { generateOtp } from '../utils/otp.js';
import { sendOtp as sendOtpSms } from '../utils/sendOtp.js';
import { hashOtp } from '../Models/Otp.js';

// If a token was revoked less than this long ago, treat a second use as a
// harmless concurrent request (e.g. two tabs), not as token theft.
const REUSE_GRACE_MS = Number(process.env.REFRESH_REUSE_GRACE_MS) || 15 * 1000;

const OTP_EXPIRES_IN_MS =
    Number(process.env.OTP_EXPIRES_IN_MIN) * 60 * 1000 || 10 * 60 * 1000; // default 10 min
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS) || 5;

const userPayload = (u) => ({
    id: u._id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    photo: u.photo,
    role: u.role.name,
    permissions: u.role.permissions,
});

/**
 * Step 1 of OTP login: generate a 6-digit OTP, hash it, store it with an expiry,
 * and send it to the user's phone number.
 * Body: { phone: string }
 */
export const sendOtp = async (req, res, next) => {
    try {
        const { phone } = req.body;

        if (!phone) {
            return res.status(400).json({
                message: 'Phone number is required',
            });
        }

        // Normalize phone: keep as-is (E.164 preferred). Trim whitespace.
        const normalizedPhone = String(phone).trim();

        // Resolve user by phone (must exist and be active)
        const user = await User.findOne({ phone: normalizedPhone }).populate('role');
        if (!user) {
            return res.status(404).json({
                message: 'No account found with this phone number',
            });
        }

        if (!user.isActive) {
            return res.status(403).json({
                message: 'Account is deactivated',
            });
        }

        // Generate OTP and hash it (never store plaintext)
        const code = generateOtp();
        const codeHash = hashOtp(code);
        const expiresAt = new Date(Date.now() + OTP_EXPIRES_IN_MS);

        // Upsert: one active unverified OTP per phone at a time
        await Otp.findOneAndUpdate(
            { phone: normalizedPhone, verified: false },
            {
                $set: { codeHash, expiresAt, attempts: 0 },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        // Send the OTP via SMS transport (dev mode logs to console)
        await sendOtpSms(normalizedPhone, code);

        return res.json({
            message: 'OTP sent successfully',
            phone: normalizedPhone,
            // In production, do NOT return the code. It's returned here only for
            // local dev/testing when SMS provider is not configured.
            ...(process.env.NODE_ENV === 'development' ? { otp: code } : {}),
            expiresIn: Math.round(OTP_EXPIRES_IN_MS / 1000),
        });
    } catch (err) {
        next(err);
    }
};

/**
 * Step 2 of OTP login: verify the OTP code and issue JWT access + refresh tokens.
 * Body: { phone: string, otp: string }
 */
export const verifyOtp = async (req, res, next) => {
    try {
        const { phone, otp } = req.body;

        if (!phone || !otp) {
            return res.status(400).json({
                message: 'Phone number and OTP are required',
            });
        }

        const normalizedPhone = String(phone).trim();
        const code = String(otp).trim();

        const otpRecord = await Otp.findOne({
            phone: normalizedPhone,
            verified: false,
        });

        if (!otpRecord) {
            return res.status(404).json({
                message: 'No active OTP found for this phone number. Request a new one.',
            });
        }

        // Expired?
        if (otpRecord.expiresAt < new Date()) {
            return res.status(410).json({
                message: 'OTP has expired. Request a new one.',
            });
        }

        // Max attempts reached?
        if (otpRecord.attempts >= OTP_MAX_ATTEMPTS) {
            return res.status(429).json({
                message: 'Too many failed OTP attempts. Request a new one.',
            });
        }

        // Increment attempts
        otpRecord.attempts += 1;
        await otpRecord.save();

        // Compare hashed OTP
        const isMatch = hashOtp(code) === otpRecord.codeHash;
        if (!isMatch) {
            return res.status(401).json({
                message: 'Invalid OTP code',
            });
        }

        // Mark OTP as verified (consumed)
        otpRecord.verified = true;
        await otpRecord.save();

        // Load user and check active status
        const user = await User.findOne({ phone: normalizedPhone }).populate('role');
        if (!user || !user.isActive) {
            return res.status(401).json({
                message: 'User not found or deactivated',
            });
        }

        return res.json({
            message: 'OTP verified successfully',
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