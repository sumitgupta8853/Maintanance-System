import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "./DB/DB.js";
import Role from "./Models/Role.js";
import User from "./Models/User.js";
import Department from "./Models/Department.js";
import { logger } from "./utils/logger.js";

logger.info("Seeding...");

// Create the role if missing, otherwise add any missing permissions.
async function upsertRole({ name, description, permissions, departmentId, isSystem = false }) {
    let role = await Role.findOne({ name });

    if (!role) {
        const data = { name, description, permissions, isSystem };
        if (departmentId) data.departmentId = departmentId; // omit instead of passing null
        role = await Role.create(data);
        logger.info(`Created ${name} role`);
        return role;
    }

    const merged = [...new Set([...role.permissions, ...permissions])];
    if (merged.length !== role.permissions.length) {
        role.permissions = merged;
        await role.save();
        logger.info(`Updated ${name} role permissions`);
    } else {
        logger.info(`Role already up to date: ${name}`);
    }
    return role;
}

async function upsertDepartment(name, description) {
    let dept = await Department.findOne({ name });
    if (!dept) {
        dept = await Department.create({ name, description });
        logger.info(`Created ${name} department`);
    }
    return dept;
}

try {
    await connectDB();

    // --- Departments ---
    const engDept = await upsertDepartment("engineering", "Engineering Department");
    await upsertDepartment("human_resources", "Human Resources Department");

    // --- Roles ---
    let adminRole = await Role.findOne({ name: "admin" });
    if (!adminRole) {
        adminRole = await Role.create({
            name: "admin",
            description: "Full access",
            permissions: ["*"],
            isSystem: true,
        });
        logger.info("Created admin role");
    } else if (!adminRole.permissions.includes("*")) {
        adminRole.permissions = ["*"];
        await adminRole.save();
        logger.info("Updated admin role permissions");
    }

    await upsertRole({
        name: "technical_manager",
        description: "Technical Manager",
        permissions: [
            "ticket:view_department", "ticket:assign", "ticket:close", "ticket:update_status", "ticket:view",
            "ticket:edit", "ticket:comment", "users:create", "report:read",
            "role:view", "department:view",
            "department:manage", "ticket:third_party_issue",
        ],
        departmentId: engDept._id,
    });

    await upsertRole({
        name: "service_engineer",
        description: "Service Engineer",
        permissions: [
            "ticket:view_assigned", "ticket:update_status", "ticket:close",
            "ticket:view", "ticket:comment", "ticket:create", "ticket:edit",
            "ticket:third_party_issue",
        ],
        departmentId: engDept._id,
    });

    await upsertRole({
        name: "cc_executive",
        description: "CC Executive",
        permissions: ["ticket:create", "ticket:view", "ticket:edit", "ticket:comment"],
    });

    await upsertRole({
        name: "customer_support_manager",
        description: "Customer Support Manager - full ticket lifecycle control",
        permissions: [
            "ticket:create", "ticket:view", "ticket:view_department", "ticket:assign",
            "ticket:edit", "ticket:close", "ticket:update_status", "ticket:comment",
            "ticket:all_departments", "users:view", "ticket:third_party_issue"
        ],
    });

    async function upsertUser({ name, email, password, role, phone }) {
        let user = await User.findOne({ email });
        if (!user) {
            user = await User.create({
                name,
                email,
                password,
                role,
                phone,
            });
            logger.info(`Created user: ${email} (${phone})`);
            return user;
        }
        if (user.phone !== phone) {
            user.phone = phone;
            await user.save();
            logger.info(`Updated phone for user: ${email}`);
        }
        return user;
    }

    // --- Users (one per role, each with a phone for OTP login) ---
    const adminEmail = (process.env.ADMIN_EMAIL || "admin@example.com").toLowerCase();
    const adminUser = await upsertUser({
        name: process.env.ADMIN_NAME || "Super Admin",
        email: adminEmail,
        password: process.env.ADMIN_PASSWORD || "Admin@12345",
        role: adminRole._id,
        phone: "+917277506057",
    });

    const tmRole = await Role.findOne({ name: "technical_manager" });
    if (tmRole) {
        await upsertUser({
            name: "Technical Manager",
            email: "tm@example.com",
            password: "Test@1234",
            role: tmRole._id,
            phone: "+919000000002",
        });
    }

    const seRole = await Role.findOne({ name: "service_engineer" });
    if (seRole) {
        await upsertUser({
            name: "Service Engineer",
            email: "se@example.com",
            password: "Test@1234",
            role: seRole._id,
            phone: "+919000000003",
        });
    }

    const cceRole = await Role.findOne({ name: "cc_executive" });
    if (cceRole) {
        await upsertUser({
            name: "CC Executive",
            email: "cce@example.com",
            password: "Test@1234",
            role: cceRole._id,
            phone: "+919000000004",
        });
    }

    const csmRole = await Role.findOne({ name: "customer_support_manager" });
    if (csmRole) {
        await upsertUser({
            name: "Customer Support Manager",
            email: "csm@example.com",
            password: "Test@1234",
            role: csmRole._id,
            phone: "+919000000005",
        });
    }
} catch (err) {
    logger.error({ err }, "Seed failed");
    if (err.name === "ValidationError") {
        for (const [field, e] of Object.entries(err.errors)) {
            logger.error(` - ${field}: ${e.message}`);
        }
    }
    process.exitCode = 1;
} finally {
    await mongoose.disconnect();
}