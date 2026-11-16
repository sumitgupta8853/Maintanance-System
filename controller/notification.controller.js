import DeviceToken from '../Models/DeviceToken.js';
import User from '../Models/User.js';
import { sendToUser, sendToTopic, sendMulticast } from '../utils/pushNotification.js';
import { auditLog } from '../utils/audit.js';

/**
 * POST /api/notifications/register-device
 * Register (or update) the current user's FCM device token.
 * Body: { deviceToken, deviceId?, platform, deviceModel?, osVersion?, appVersion? }
 */
export const registerDevice = async (req, res, next) => {
  try {
    const { deviceToken, deviceId, platform, deviceModel, osVersion, appVersion } = req.body;

    if (!deviceToken || !platform) {
      return res.status(400).json({ message: 'deviceToken and platform are required' });
    }

    const validPlatforms = ['android', 'ios', 'web'];
    if (!validPlatforms.includes(platform)) {
      return res.status(400).json({ message: 'platform must be one of: android, ios, web' });
    }

    const now = new Date();

    // Retire older tokens from the same physical device (FCM token refresh / reinstall)
    if (deviceId) {
      await DeviceToken.updateMany(
        { user: req.user._id, deviceId, deviceToken: { $ne: deviceToken } },
        { $set: { isActive: false } }
      );
    }

    const update = {
      user: req.user._id, // reassign if another user previously used this token (shared phone)
      deviceId: deviceId || null,
      platform,
      deviceModel: deviceModel || null,
      osVersion: osVersion || null,
      appVersion: appVersion || null,
      isActive: true,
      lastUsedAt: now,
    };

    // Look up by token only: tokens are globally unique
    const device = await DeviceToken.findOneAndUpdate(
      { deviceToken },
      { $set: update, $setOnInsert: { createdAt: now } },
      { upsert: true, new: true }
    );

    await auditLog({
      actor: req.user._id,
      action: 'notification:register_device',
      target: device,
      targetType: 'DeviceToken',
      targetId: device._id,
      outcome: 'success',
      details: { platform, deviceId },
      req,
    });

    return res.json({ message: 'Device registered', device });
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/notifications/unregister-device
 * Deactivate a device token for the current user.
 * Body: { deviceToken } or { deviceId }
 */
export const unregisterDevice = async (req, res, next) => {
  try {
    const { deviceToken, deviceId } = req.body;

    const filter = { user: req.user._id };
    if (deviceToken) filter.deviceToken = deviceToken;
    else if (deviceId) filter.deviceId = deviceId;
    else {
      return res.status(400).json({ message: 'deviceToken or deviceId is required' });
    }

    const device = await DeviceToken.findOne(filter);
    if (!device) {
      return res.status(404).json({ message: 'Device not found' });
    }

    device.isActive = false;
    await device.save();

    await auditLog({
      actor: req.user._id,
      action: 'notification:unregister_device',
      target: device,
      targetType: 'DeviceToken',
      targetId: device._id,
      outcome: 'success',
      details: { platform: device.platform },
      req,
    });

    return res.json({ message: 'Device unregistered' });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/notifications/devices
 * List the current user's active device tokens.
 */
export const listMyDevices = async (req, res, next) => {
  try {
    const filter = { user: req.user._id };
    if (req.query.all !== 'true') filter.isActive = true;

    const devices = await DeviceToken.find(filter)
      .select('deviceToken deviceId platform deviceModel osVersion appVersion isActive lastUsedAt createdAt')
      .sort({ lastUsedAt: -1 });

    return res.json({ count: devices.length, devices });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/notifications/send
 * Admin-only: send a push notification to a user, topic, or raw tokens.
 * Body: one of:
 *  - { userId, title, body, data? }
 *  - { topic, title, body, data? }
 *  - { tokens: [...], title, body, data? }
 * Requires permission: notification:send
 */
export const sendNotification = async (req, res, next) => {
  try {
    const { userId, topic, tokens, title, body, data } = req.body;

    if (!title || !body) {
      return res.status(400).json({ message: 'title and body are required' });
    }

    let result;
    let audit;

    if (userId) {
      const targetUser = await User.findById(userId);
      if (!targetUser) {
        return res.status(404).json({ message: 'Target user not found' });
      }
      result = await sendToUser(userId, title, body, data);
      audit = {
        action: 'notification:send_to_user',
        target: targetUser,
        targetType: 'User',
        targetId: targetUser._id,
        details: { title },
      };
    } else if (topic) {
      result = await sendToTopic(topic, title, body, data);
      audit = {
        action: 'notification:send_to_topic',
        target: null,
        targetType: 'Topic',
        targetId: topic,
        details: { title },
      };
    } else if (tokens && Array.isArray(tokens) && tokens.length > 0) {
      result = await sendMulticast(tokens, title, body, data);
      audit = {
        action: 'notification:send_multicast',
        target: null,
        targetType: 'Tokens',
        targetId: null,
        details: { title, tokenCount: tokens.length },
      };
    } else {
      return res.status(400).json({
        message: 'Provide one of: userId, topic, or tokens[]',
      });
    }

    const failedToSend = !result || !!result.error;
    const nothingSent = !failedToSend && result.sent === 0;

    await auditLog({
      actor: req.user._id,
      ...audit,
      outcome: failedToSend || nothingSent ? 'failure' : 'success',
      details: { ...audit.details, result },
      req,
    });

    if (failedToSend) {
      return res.status(503).json({ message: 'Push service unavailable', result });
    }

    if (result.total === 0) {
      return res.status(200).json({ message: 'No active devices to notify', result });
    }

    if (result.sent === 0) {
      return res.status(502).json({ message: 'Notification could not be delivered', result });
    }

    return res.json({ message: 'Notification sent', result });
  } catch (err) {
    next(err);
  }
};