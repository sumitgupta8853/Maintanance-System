import mongoose from 'mongoose';
import crypto from 'crypto';

const otpSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      index: true,
    },
    // SHA-256 hash of the OTP code (never store plaintext)
    codeHash: {
      type: String,
      required: true,
    },
    // Whether this OTP has been successfully verified
    verified: {
      type: Boolean,
      default: false,
    },
    // Number of verification attempts (for brute-force protection)
    attempts: {
      type: Number,
      default: 0,
      max: 10,
    },
    // When the OTP expires
    expiresAt: {
      type: Date,
      required: true,
      index: { expireAfterSeconds: 0 }, // TTL index auto-removes expired docs
    },
  },
  { timestamps: true }
);

// One active (unverified, unexpired) OTP per phone at a time
otpSchema.index({ phone: 1, verified: false }, { unique: true, partialFilterExpression: { verified: false } });

// Hash the OTP code before storing (mirrors RefreshToken hashing pattern)
export const hashOtp = (code) =>
  crypto.createHash('sha256').update(String(code)).digest('hex');

const Otp = mongoose.model('Otp', otpSchema);

export default Otp;
