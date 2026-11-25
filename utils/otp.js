/**
 * Generate a 6-digit numeric OTP code.
 * @returns {string} A zero-padded 6-digit string, e.g. "012345"
 */
export const generateOtp = () => {
  const code = Math.floor(100000 + Math.random() * 900000);
  return String(code).padStart(6, '0');
};
