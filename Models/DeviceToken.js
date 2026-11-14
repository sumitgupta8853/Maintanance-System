import mongoose from 'mongoose';

const deviceTokenSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    deviceToken: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    deviceId: {
      type: String,
      trim: true,
      default: null,
    },
    platform: {
      type: String,
      enum: ['android', 'ios', 'web'],
      required: true,
    },
    deviceModel: {
      type: String,
      trim: true,
      default: null,
    },
    osVersion: {
      type: String,
      trim: true,
      default: null,
    },
    appVersion: {
      type: String,
      trim: true,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    lastUsedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// One active token per (user, deviceId) combination - re-registration updates the token
deviceTokenSchema.index({ user: 1, deviceId: 1 }, { unique: true, partialFilterExpression: { isActive: true } });

const DeviceToken = mongoose.model('DeviceToken', deviceTokenSchema);

export default DeviceToken;
