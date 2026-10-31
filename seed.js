import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "./DB/DB.js";
import Role from "./Models/Role.js";
import User from "./Models/User.js";
import Department from "./Models/Department.js";

console.log("Seeding...");

// Create the role if missing, otherwise add any missing permissions.
async function upsertRole({ name, description, permissions, departmentId, isSystem = false }) {
    let role = await Role.findOne({ name });

    if (!role) {
        const data = { name, description, permissions, isSystem };
        if (departmentId) data.departmentId = departmentId; // omit instead of passing null
        role = await Role.create(data);
        console.log(`Created ${name} role`);
        return role;
    }

    const merged = [...new Set([...role.permissions, ...permissions])];
    if (merged.length !== role.permissions.length) {
        role.permissions = merged;
        await role.save();
        console.log(`Updated ${name} role permissions`);
    } else {
        console.log(`Role already up to date: ${name}`);
    }
    return role;
}

async function upsertDepartment(name, description) {
    let dept = await Department.findOne({ name });
    if (!dept) {
        dept = await Department.create({ name, description });
        console.log(`Created ${name} department`);
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
        console.log("Created admin role");
    } else if (!adminRole.permissions.includes("*")) {
        adminRole.permissions = ["*"];
        await adminRole.save();
        console.log("Updated admin role permissions");
    }

    await upsertRole({
        name: "technical_manager",
        description: "Technical Manager",
        permissions: [
            "ticket:view_department", "ticket:assign", "ticket:close", "ticket:view",
            "ticket:edit", "ticket:comment", "users:create", "report:read",
        ],
        departmentId: engDept._id,
    });

    await upsertRole({
        name: "service_engineer",
        description: "Service Engineer",
        permissions: [
            "ticket:view_assigned", "ticket:update_status", "ticket:close",
            "ticket:view", "ticket:edit", "ticket:comment",
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
            "ticket:all_departments"
        ],
    });

    // --- Admin user ---
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
    console.error("Seed failed:", err);          // full error, incl. err.errors for validation
    if (err.name === "ValidationError") {
        for (const [field, e] of Object.entries(err.errors)) {
            console.error(` - ${field}: ${e.message}`);
        }
    }
    process.exitCode = 1;
} finally {
    await mongoose.disconnect();
}