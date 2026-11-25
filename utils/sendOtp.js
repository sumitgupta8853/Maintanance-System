import { httpClient } from './httpClient.js';
import { forName } from './circuitBreaker.js';
import { logger } from './logger.js';

const SMS_PROVIDER_PRIMARY = '2factor';
const SMS_PROVIDER_FALLBACK = process.env.SMS_FALLBACK_PROVIDER || 'msg91';

const SMS_TEMPLATE = 'REGISTER MESSAGE TO E PLUG MEMBERS';
const SMS_TIMEOUT_MS = 10000;

const smsBreaker = forName('sms:2factor', {
  threshold: 5,
  cooldownMs: 60000,
  windowMs: 300000,
  halfOpenMax: 1,
});

const buildSmsUrl = (apiKey, phone_number, otp) => {
  const normalizedPhone = String(phone_number || '').trim();
  const formattedPhone = normalizedPhone.startsWith('+')
    ? normalizedPhone
    : `+91${normalizedPhone}`;
  const templateName = encodeURIComponent(SMS_TEMPLATE);
  const encodedPhone = encodeURIComponent(formattedPhone);

  return {
    url: `https://2factor.in/API/V1/${apiKey}/SMS/${encodedPhone}/${otp}/${templateName}`,
    formattedPhone,
  };
};

// Fallback: send via MSG91 (or another provider) when 2factor is down
const buildFallbackSmsUrl = (apiKey, phone_number, otp) => {
  const normalizedPhone = String(phone_number || '').trim();
  const formattedPhone = normalizedPhone.startsWith('+')
    ? normalizedPhone
    : `+91${normalizedPhone}`;
  const encodedPhone = encodeURIComponent(formattedPhone.replace('+', ''));
  const encodedOtp = encodeURIComponent(otp);
  return {
    url: `https://api.msg91.com/api/v5/flow/`,
    formattedPhone,
    payload: {
      sender: 'ECPLUG',
      flow_id: process.env.MSG91_FLOW_ID || 'default_otp_flow',
      mobiles: encodedPhone,
      VAR1: encodedOtp,
    },
  };
};

const isProviderError = (error) =>
  error.message?.startsWith('OTP provider error:');

export async function sendOtp(phone, code) {
  const apiKey = process.env.TWO_FACTOR_API_KEY;
  if (!apiKey) {
    const error = new Error(
      'TWO_FACTOR_API_KEY is missing in environment variables'
    );
    logger.error({ error: error.message }, '[OTP provider] Missing API key');
    return { sent: false, error: error.message };
  }

  const { url, formattedPhone } = buildSmsUrl(apiKey, phone, code);
  const fallbackApiKey =
    process.env.MSG91_API_KEY || process.env.SMS_FALLBACK_API_KEY;

  const isPrimaryOpen = await smsBreaker.isOpen().catch(() => false);
  if (isPrimaryOpen) {
    logger.warn(
      { phone_number: formattedPhone },
      '[OTP provider] Circuit breaker OPEN for 2factor, attempting fallback...'
    );
    if (fallbackApiKey) {
      return sendViaFallback(fallbackApiKey, phone, code, formattedPhone);
    }
    return {
      sent: false,
      error:
        'OTP provider request failed: 2factor circuit breaker open, no fallback configured',
    };
  }

  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await httpClient.get(url, {
        timeout: SMS_TIMEOUT_MS,
        headers: { Accept: 'application/json' },
        validateStatus: () => true,
      });

      const data = response.data;
      if (
        response.status < 200 ||
        response.status >= 300 ||
        !data ||
        data.Status !== 'Success'
      ) {
        const details =
          data?.Details || data?.message || `Provider returned status ${response.status}`;
        const error = new Error(`OTP provider error: ${details}`);
        logger.error(
          {
            phone_number: formattedPhone,
            status: response.status,
            details,
          },
          '[OTP provider] Failed to send SMS'
        );
        throw error;
      }

      await smsBreaker.recordSuccess();
      logger.info(
        { phone_number: formattedPhone },
        '[OTP provider] SMS sent successfully via 2factor'
      );
      return {
        sent: true,
        provider: SMS_PROVIDER_PRIMARY,
        messageId: data?.Details || `2factor-${Date.now()}`,
      };
    } catch (error) {
      const providerError = isProviderError(error);
      const networkCode = error.code || error.cause?.code;
      const message = providerError
        ? error.message
        : `OTP provider request failed: ${error.message}${networkCode ? ` (${networkCode})` : ''}`;

      const lastAttempt = attempt === MAX_ATTEMPTS;

      if (!providerError && !lastAttempt) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        logger.warn(
          {
            phone_number: formattedPhone,
            code: networkCode || null,
            attempt,
            maxAttempts: MAX_ATTEMPTS,
            retryInMs: backoffMs,
          },
          `[OTP provider] Attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying in ${backoffMs}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }

      await smsBreaker.recordFailure();

      logger.error(
        {
          phone_number: formattedPhone,
          message,
          code: networkCode || null,
          attempt,
        },
        '[OTP provider] SMS send failed'
      );

      if (lastAttempt && fallbackApiKey) {
        logger.warn(
          { phone_number: formattedPhone },
          '[OTP provider] Primary provider (2factor) exhausted, trying fallback...'
        );
        return sendViaFallback(fallbackApiKey, phone, code, formattedPhone);
      }

      return { sent: false, error: message };
    }
  }

  return { sent: false, error: 'OTP provider request failed after all attempts' };
}

const sendViaFallback = async (apiKey, phone_number, otp, formattedPhone) => {
  const { url, payload } = buildFallbackSmsUrl(apiKey, phone_number, otp);

  try {
    const response = await httpClient.post(url, payload, {
      headers: {
        authkey: apiKey,
        'Content-Type': 'application/json',
      },
      timeout: SMS_TIMEOUT_MS,
      validateStatus: () => true,
    });

    const data = response.data;
    if (response.status < 200 || response.status >= 300) {
      const details =
        data?.message || `Fallback provider returned status ${response.status}`;
      const error = new Error(`OTP provider error (fallback): ${details}`);
      logger.error(
        {
          phone_number: formattedPhone,
          status: response.status,
          details,
        },
        '[OTP provider] Fallback SMS failed'
      );
      return { sent: false, error: error.message };
    }

    logger.info(
      { phone_number: formattedPhone },
      '[OTP provider] Fallback SMS sent successfully'
    );
    return {
      sent: true,
      provider: SMS_PROVIDER_FALLBACK,
      messageId: data?.messageId || `msg91-${Date.now()}`,
    };
  } catch (error) {
    const message = `OTP provider request failed (fallback): ${error.message}`;
    logger.error(
      {
        phone_number: formattedPhone,
        message,
        code: error.code || null,
      },
      '[OTP provider] Fallback SMS failed'
    );
    return { sent: false, error: message };
  }
};
