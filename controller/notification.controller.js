import DeviceToken from '../Models/DeviceToken.js';
import User from '../Models/User.js';
import { sendToUser, sendToDevice, sendToTopic, sendMulticast } from '../utils/pushNotification.js';
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

    const update = {
      deviceId: deviceId || null,
      platform,
      deviceModel: deviceModel || null,
      osVersion: osVersion || null,
      appVersion: appVersion || null,
      isActive: true,
      lastUsedAt: new Date(),
    };

    const device = await DeviceToken.findOneAndUpdate(
      { user: req.user._id, deviceToken },
      { $set: update, $setOnInsert: { createdAt: new Date() } },
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
 * Deactivate/remove a device token for the current user.
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
    const devices = await DeviceToken.find({
      user: req.user._id,
      isActive: true,
    })
      .select('deviceToken platform deviceModel osVersion appVersion lastUsedAt createdAt')
      .sort({ lastUsedAt: -1 });

    return res.json({ devices });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/notifications/send
 * Admin-only: send a push notification to a specific user, topic, or raw tokens.
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

    if (userId) {
      const targetUser = await User.findById(userId);
      if (!targetUser) {
        return res.status(404).json({ message: 'Target user not found' });
      }
      result = await sendToUser(userId, title, body, data);
      await auditLog({
        actor: req.user._id,
        action: 'notification:send_to_user',
        target: targetUser,
        targetType: 'User',
        targetId: targetUser._id,
        outcome: 'success',
        details: { title, result },
        req,
      });
    } else if (topic) {
      result = await sendToTopic(topic, title, body, data);
      await auditLog({
        actor: req.user._id,
        action: 'notification:send_to_topic',
        target: null,
        targetType: 'Topic',
        targetId: topic,
        outcome: 'success',
        details: { title, result },
        req,
      });
    } else if (tokens && Array.isArray(tokens) && tokens.length > 0) {
      result = await sendMulticast(tokens, title, body, data);
      await auditLog({
        actor: req.user._id,
        action: 'notification:send_multicast',
        target: null,
        targetType: 'Tokens',
        targetId: null,
        outcome: 'success',
        details: { title, tokenCount: tokens.length, result },
        req,
      });
    } else {
      return res.status(400).json({
        message: 'Provide one of: userId, topic, or tokens[]',
      });
    }

    return res.json({ message: 'Notification sent', result });
  } catch (err) {
    next(err);
  }
};
