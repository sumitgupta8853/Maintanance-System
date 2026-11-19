// import rateLimit from 'express-rate-limit';

// // General API rate limiter: 100 requests per 15 minutes per IP
// export const apiLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: 100, // limit each IP to 100 requests per windowMs
//   message: {
//     message: 'Too many requests from this IP, please try again after 15 minutes',
//     code: 'RATE_LIMIT_EXCEEDED'
//   },
//   standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
//   legacyHeaders: false // Disable the `X-RateLimit-*` headers
// });

// // Auth route rate limiter: 5 attempts per 15 minutes (stricter for login/register)
// // export const authLimiter = rateLimit({
// //   windowMs: 15 * 60 * 1000, // 15 minutes
// //   max: 5, // limit each IP to 5 failed login attempts per windowMs
// //   message: {
// //     message: 'Too many failed attempts, please try again after 15 minutes',
// //     code: 'AUTH_RATE_LIMIT_EXCEEDED'
// //   },
// //   standardHeaders: true,
// //   legacyHeaders: false
// // });

// // Ticket write rate limiter: 50 requests per 15 minutes (for ticket creation/updates)
// export const ticketWriteLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: 50, // limit each IP to 50 ticket write operations per windowMs
//   message: {
//     message: 'Too many ticket operations, please try again after 15 minutes',
//     code: 'TICKET_RATE_LIMIT_EXCEEDED'
//   },
//   standardHeaders: true,
//   legacyHeaders: false
// });

// // Health check endpoint: no rate limiting (for load balancer health checks)
// export const healthLimiter = rateLimit({
//   windowMs: 1 * 60 * 1000, // 1 minute
//   max: 30, // allow 30 health checks per minute
//   message: {
//     message: 'Health check rate limited',
//     code: 'HEALTH_RATE_LIMITED'
//   },
//   standardHeaders: true,
//   legacyHeaders: false,
//   skip: (req) => req.path.startsWith('/health') // Actually disable for health routes - will be configured in app.js
// });