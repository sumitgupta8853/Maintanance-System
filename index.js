import "dotenv/config";
import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
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

app.get("/", (req, res) => {
    res.send("Hello World!");
});

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

    const PORT = process.env.PORT || 6500;
    app.listen(PORT, () => {
        logger.info(`Server is running on port ${PORT}`);
    });
});