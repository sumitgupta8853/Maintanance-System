import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "./DB/DB.js";
import Role from "./Models/Role.js";
import User from "./Models/User.js";
import Department from "./Models/Department.js";

console.log("Seeding...");

try {
    await connectDB();

    // --- Departments ---
    let engDept = await Department.findOne({ name: "engineering" });
    if (!engDept) {
        engDept = await Department.create({ name: "engineering", description: "Engineering Department" });
        console.log("Created engineering department");
    }

    let hrDept = await Department.findOne({ name: "human_resources" });
    if (!hrDept) {
        hrDept = await Department.create({ name: "human_resources", description: "Human Resources Department" });
        console.log("Created human_resources department");
    }

    // --- Roles ---
    let adminRole = await Role.findOne({ name: "admin" });
    if (!adminRole) {
        adminRole = await Role.create({ name: "admin", description: "Full access", permissions: ["*"], isSystem: true });
        console.log("Created admin role");
    } else {
        if (!adminRole.permissions.includes("*")) {
            adminRole.permissions = ["*"];
            await adminRole.save();
            console.log("Updated admin role permissions");
        }
    }

    // technical_manager permissions
    let techMgrRole = await Role.findOne({ name: "technical_manager" });
    if (!techMgrRole) {
        techMgrRole = await Role.create({
            name: "technical_manager",
            description: "Technical Manager",
            permissions: ["ticket:view_department", "ticket:assign", "ticket:close", "ticket:view", "ticket:edit", "ticket:comment", "users:create", "report:read"],
            departmentId: engDept._id,
            isSystem: false
        });
        console.log("Created technical_manager role");
    } else {
        const needed = ["ticket:view_department", "ticket:assign", "ticket:close", "ticket:view", "ticket:edit", "ticket:comment", "users:create", "report:read"];
        const missing = needed.filter((p) => !techMgrRole.permissions.includes(p));
        if (missing.length > 0) {
            techMgrRole.permissions = [...new Set([...techMgrRole.permissions, ...missing])];
            await techMgrRole.save();
            console.log("Updated technical_manager role permissions");
        }
    }

    // service_engineer permissions
    let svcEngRole = await Role.findOne({ name: "service_engineer" });
    if (!svcEngRole) {
        svcEngRole = await Role.create({
            name: "service_engineer",
            description: "Service Engineer",
            permissions: ["ticket:view_assigned", "ticket:update_status", "ticket:close", "ticket:view", "ticket:edit", "ticket:comment"],
            departmentId: engDept._id,
            isSystem: false
        });
        console.log("Created service_engineer role");
    } else {
        const needed = ["ticket:view_assigned", "ticket:update_status", "ticket:close", "ticket:view", "ticket:edit", "ticket:comment"];
        const missing = needed.filter((p) => !svcEngRole.permissions.includes(p));
        if (missing.length > 0) {
            svcEngRole.permissions = [...new Set([...svcEngRole.permissions, ...missing])];
            await svcEngRole.save();
            console.log("Updated service_engineer role permissions");
        }
    }

    // cc_executive permissions
    let ccExecRole = await Role.findOne({ name: "cc_executive" });
    if (!ccExecRole) {
        ccExecRole = await Role.create({
            name: "cc_executive",
            description: "CC Executive",
            permissions: ["ticket:create", "ticket:view", "ticket:edit", "ticket:comment"],
            isSystem: false
        });
        console.log("Created cc_executive role");
    } else {
        const needed = ["ticket:create", "ticket:view", "ticket:edit", "ticket:comment"];
        const missing = needed.filter((p) => !ccExecRole.permissions.includes(p));
        if (missing.length > 0) {
            ccExecRole.permissions = [...new Set([...ccExecRole.permissions, ...missing])];
            await ccExecRole.save();
            console.log("Updated cc_executive role permissions");
        }
    }

    const email = (process.env.ADMIN_EMAIL || "admin@example.com").toLowerCase();
    if (await User.findOne({ email })) {
        console.log(`Admin user already exists: ${email}`);
    } else {
        await User.create({
            name: process.env.ADMIN_NAME || "Super Admin",
            email,
            password: process.env.ADMIN_PASSWORD || "Admin@12345",
            role: adminRole._id,
        });
        console.log(`Created admin user: ${email}`);
    }
} catch (err) {
    console.error("Seed failed:", err.message);
    process.exitCode = 1;
} finally {
    await mongoose.disconnect();
}