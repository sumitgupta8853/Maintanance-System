import "dotenv/config";
import express from "express";
import { connectDB } from "./DB/DB.js";
import { startHealthMonitor } from "./utils/healthMonitor.js";

import { authRoutes } from "./routes/auth.Routes.js";
import roleRoutes from "./routes/role.Routes.js";
import userRoutes from "./routes/user.Routes.js";
import permissionRoutes from "./routes/permission.Routes.js";
import departmentRoutes from "./routes/department.Routes.js";
import ticketRoutes from "./routes/ticket.Routes.js";

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
    res.send("Hello World!");
});

app.use("/api/auth", authRoutes);
app.use("/api/roles", roleRoutes);
app.use("/api/users", userRoutes);
app.use("/api/permissions", permissionRoutes);
app.use("/api/departments", departmentRoutes);
app.use("/api/support/tickets", ticketRoutes);

app.use((req, res) => res.status(404).json({ message: "Route not found" }));

// Central error handler
app.use((err, req, res, next) => {
    console.error(err);
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
    // Start auto ticket creation health monitor (every minute)
    startHealthMonitor();

    const PORT = process.env.PORT || 6500;
    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
});