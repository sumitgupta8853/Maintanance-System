import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import path from 'path';

// RabbitMQ and background workers
import { initRabbitMQ } from './middlewares/publisher.js';
import { startNotificationConsumer } from './utils/notificationConsumer.js';
import { startAuditWorker } from './utils/auditWorker.js';
import { startEscalationWorker } from './workers/escalationWorker.js';

// General API rate limiter: 100 requests per 15 minutes per IP
// export const apiLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: 100, // limit each IP to 100 requests per windowMs
//   message: {
//     message: "Too many requests from this IP, please try again after 15 minutes",
//     code: "RATE_LIMIT_EXCEEDED"
//   },
//   standardHeaders: true,
//   legacyHeaders: false
// });

// // Auth route rate limiter: 5 attempts per 15 minutes (stricter for login/register)
// export const authLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: 5, // limit each IP to 5 failed login attempts per windowMs
//   message: {
//     message: "Too many failed attempts, please try again after 15 minutes",
//     code: "AUTH_RATE_LIMIT_EXCEEDED"
//   },
//   standardHeaders: true,
//   legacyHeaders: false
// });

// // Ticket write rate limiter: 50 requests per 15 minutes (for ticket creation/updates)
// export const ticketWriteLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: 50, // limit each IP to 50 ticket write operations per windowMs
//   message: {
//     message: "Too many ticket operations, please try again after 15 minutes",
//     code: "TICKET_RATE_LIMIT_EXCEEDED"
//   },
//   standardHeaders: true,
//   legacyHeaders: false
// });
import { connectDB } from "./DB/DB.js";
import { startHealthMonitor } from "./utils/healthMonitor.js";
import { logger } from "./utils/logger.js";
import { initFCM } from "./utils/pushNotification.js";

import notificationRoutes from "./routes/notification.Routes.js";

import { authRoutes } from "./routes/auth.Routes.js";
import roleRoutes from "./routes/role.Routes.js";
import userRoutes from "./routes/user.Routes.js";
import permissionRoutes from "./routes/permission.Routes.js";
import departmentRoutes from "./routes/department.Routes.js";
import ticketRoutes from "./routes/ticket.Routes.js";
import monitoringRoutes from "./routes/monitoring.Routes.js";
import dashboardRoutes from "./routes/dashboard.Routes.js";




const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));

// HTTP request logging with pino
app.use(
  pinoHttp({
    logger,
    serializers: {
      req: (req) => ({
        method: req.method,
        url: req.url,
        ip: req.ip,
        headers: req.headers,
      }),
      res: (res) => ({
        statusCode: res.statusCode,
        headers: res.headers,
      }),
    },
  })
);

// Apply rate limiting: general 100 req/15min to all API routes
// app.use("/api/", apiLimiter);

// Stricter auth rate limit: 5 attempts/15min only on auth routes
// app.use("/api/auth", authLimiter);

// Health check endpoint: no rate limiting (for load balancer)
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/", (req, res) => {
  res.send("Hello World!");
});
app.use('/profiles', express.static(path.join(process.cwd(), 'uploads', 'profiles')));
app.use("/api/auth", authRoutes);
app.use("/api/roles", roleRoutes);
app.use("/api/users", userRoutes);
app.use("/api/permissions", permissionRoutes);
app.use("/api/departments", departmentRoutes);
app.use("/api/support/tickets", ticketRoutes);
app.use("/api/monitoring", monitoringRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/notifications", notificationRoutes);

app.use((req, res) => res.status(404).json({ message: "Route not found" }));

// Central error handler
app.use((err, req, res, next) => {
  logger.error({ err, req }, err.message);
  if (err.code === 11000) {
    return res.status(409).json({ message: "Duplicate value", fields: err.keyValue });
  }
  if (err.name === "ValidationError") {
    return res.status(400).json({ message: err.message });
  }

  if (err.name === "CastError") {
    return res.status(400).json({ message: `Invalid ${err.path}` });
  }
  res.status(err.status || 500).json({ message: err.message || "Server error" });
});

connectDB().then(() => {
  // Initialize Firebase Cloud Messaging (push notifications)
  initFCM();

  // Start auto ticket creation health monitor (every minute)
  startHealthMonitor();

  // Initialize RabbitMQ connection and declare exchanges/queues
  initRabbitMQ();

  // Start background workers
  startNotificationConsumer();
  startAuditWorker();
  startEscalationWorker();

  const PORT = process.env.PORT || 6500;
  app.listen(PORT, () => {
    logger.info(`Server is running on port ${PORT}`);
  });
});