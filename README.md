# Maintenance System — Backend

Node.js + Express (ESM) + MongoDB (Mongoose) REST API with JWT authentication,
role-based access control (RBAC), refresh-token rotation, and security audit logging.

---

## Table of Contents

1. [Features](#features)
2. [Tech Stack](#tech-stack)
3. [Project Structure](#project-structure)
4. [Installation](#installation)
5. [Environment Variables](#environment-variables)
6. [Database Seeding](#database-seeding)
7. [Authentication Flow](#authentication-flow)
8. [Authorization (RBAC)](#authorization-rbac)
9. [API Reference](#api-reference)
10. [Audit Logging](#audit-logging)
11. [Security & Privilege Escalation Protection](#security--privilege-escalation-protection)
12. [Error Handling](#error-handling)
13. [Available Scripts](#available-scripts)
14. [License](#license)

---

## Features

- **JWT authentication** with short-lived access tokens (15m) and long-lived refresh tokens (7d)
- **Refresh-token rotation** with reuse/revocation detection
- **Role-based access control (RBAC)** via `requirePermission()` middleware
- **Wildcard `*` permission** for admin (full access)
- **Privilege escalation protection** on user creation, updates, role management, and permission grants
- **Security audit logging** for all sensitive mutations (create/update/delete users, roles, permissions)
- **Self-protection**: users cannot change their own role or delete their own account
- **Centralized error handling** (duplicate keys, validation, cast errors, generic 500)
- **MongoDB TTL index** on refresh tokens for automatic expiration cleanup

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js (ESM, `"type": "module"`) |
| Web Framework | Express 5 |
| Database | MongoDB via Mongoose 9 |
| Auth | JSON Web Tokens (jsonwebtoken) |
| Password Hashing | bcryptjs |
| Env Config | dotenv |
| Dev | nodemon |

---

## Project Structure

```
Maintainance-System/
├── index.js                # App entry: middleware, routes, DB connection, error handler
├── seed.js                 # Database seeder (admin role + admin user)
├── .env                    # Environment variables (not committed)
├── package.json
├── package-lock.json
├── DB/
│   └── DB.js               # MongoDB connection helper
├── Models/
│   ├── User.js             # User schema (name, email, password, role, isActive)
│   ├── Role.js             # Role schema (name, description, permissions, isSystem)
│   ├── RefreshToken.js     # Refresh token store (hash, expiry, TTL index)
│   └── AuditLog.js         # Security audit log (actor, action, target, outcome, details)
├── controller/
│   ├── auth.controller.js  # login, refresh, logout, logoutAll, me
│   ├── user.controller.js  # createUser, getUsers, updateUser, deleteUser (+ audit)
│   ├── role.controller.js  # createRole, getRoles, getRole, updateRole, deleteRole (+ audit)
│   └── permission.controller.js  # listPermissions, listRolesWithPermissions, grant, revoke, set (+ audit)
├── middlewares/
│   └── auth.js             # authenticate, authorizeRoles, requirePermission
├── routes/
│   ├── auth.Routes.js
│   ├── user.Routes.js
│   ├── role.Routes.js
│   └── permission.Routes.js
└── utils/
    ├── Token.js            # hash, signAccessToken, issueRefreshToken
    └── audit.js            # auditLog() helper
```


---

## Installation

```bash
# Clone the repository
cd /Users/rajpalyadav/Sumit-Backend/Maintainance-System

# Install dependencies
npm install

# Copy environment variables (create your own .env based on the example below)
cp .env.example .env   # if .env.example exists; otherwise create .env manually

# Seed the database (creates admin role + admin user)
npm run seed

# Start the development server
npm run dev
```

Server runs on `PORT` from `.env` (default `6500` in `index.js`).

---

## Environment Variables

Create a `.env` file in the project root:

```env
MONGO_URI=mongodb://127.0.0.1:27017/maintainance-system
PORT=6500

# JWT secrets — use two DIFFERENT long random strings in production
JWT_ACCESS_SECRET=change_this_access_secret
JWT_REFRESH_SECRET=change_this_refresh_secret

ACCESS_TOKEN_EXPIRES_IN=15m
REFRESH_TOKEN_EXPIRES_IN=7d

# Seed defaults for the first admin user
ADMIN_NAME=Super Admin
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=Admin@12345
```

> ⚠️ **Security**: Change `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, and `ADMIN_PASSWORD` before deploying to production.

---

## Database Seeding

```bash
npm run seed
```

The seeder:

1. Connects to MongoDB.
2. Ensures the `admin` role exists with `["*"]` (wildcard/full access) and `isSystem: true`.
3. Ensures the `technical_manager` role exists with `["users:create", "report:read"]`.
4. Creates the default admin user from `ADMIN_*` env vars if one does not already exist.
5. Disconnects from the database.

Run it again safely — it is idempotent (won't duplicate roles or users).

---

## Authentication Flow

### Endpoints (all under `/api/auth`)

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| `POST` | `/login` | Email/password login → returns `accessToken`, `refreshToken`, `user` | No |
| `POST` | `/refresh` | Exchange refresh token for new access + refresh token pair (rotation) | No |
| `POST` | `/logout` | Delete a single refresh token (logout this device) | No |
| `POST` | `/logout-all` | Delete all refresh tokens for the user (logout all devices) | Yes (Bearer) |
| `GET` | `/me` | Return current user profile | Yes (Bearer) |

### Token Details

- **Access Token**: signed with `JWT_ACCESS_SECRET`, expires in `ACCESS_TOKEN_EXPIRES_IN` (15m). Payload: `{ id, role.name }`. Sent with every API request as `Authorization: Bearer <token>`.
- **Refresh Token**: signed with `JWT_REFRESH_SECRET`, expires in `REFRESH_TOKEN_EXPIRES_IN` (7d). Payload: `{ id, jti }`. Stored as a SHA-256 hash in MongoDB with a TTL index.
- **Refresh Rotation**: On `/refresh`, the old refresh token hash is deleted and a new one is issued. If a token is reused (not found in store), **all** refresh tokens for that user are deleted — indicating possible theft or replay.

### Middleware (`middlewares/auth.js`)

| Middleware | Purpose |
|------------|---------|
| `authenticate` | Verifies Bearer access token, fetches user (populates role), enforces `isActive`, attaches to `req.user` |
| `authorizeRoles(...roles)` | Allows only if `req.user.role.name` matches one of the listed role names |
| `requirePermission(...perms)` | Allows if role has `*` (wildcard) or every listed permission. Used on permission-protected routes |

---

## Authorization (RBAC)

Permissions are stored on the `Role` model as a string array (`permissions: [String]`). The special value `"*"` grants all permissions (admin convention).

### Default Role Permissions

| Role | Permissions | System? |
|------|-------------|---------|
| `admin` | `["*"]` | Yes |
| `technical_manager` | `["users:create", "report:read"]` | No |
| `service_engineer` | `["report:read"]` | No |
| `customer_care_manager` | `["report:read"]` | No |

### Route Protection Matrix

#### Users (`/api/users`)

| Method | Permission | Who Can Access |
|--------|------------|----------------|
| `POST` (create) | `users:create` | Admin (`*`) + Technical Manager |
| `GET` (list) | `users:read` | Admin only |
| `PUT` (update) | `users:update` | Admin only |
| `DELETE` | `users:delete` | Admin only |

#### Roles (`/api/roles`)

| Method | Permission | Who Can Access |
|--------|------------|----------------|
| All | `role:manage` | Admin only |

#### Permissions (`/api/permissions`)

| Method | Permission | Who Can Access |
|--------|------------|----------------|
| All | `permission:manage` | Admin only |

---

## API Reference

### Auth

**`POST /api/auth/login`**
```json
// Request
{ "email": "admin@example.com", "password": "Admin@12345" }

// Response (200)
{
  "accessToken": "<jwt>",
  "refreshToken": "<jwt>",
  "user": {
    "id": "...",
    "name": "Super Admin",
    "email": "admin@example.com",
    "role": "admin",
    "permissions": ["*"],
  }
}
```

**`POST /api/auth/refresh`**
```json
// Request
{ "refreshToken": "<refresh-jwt>" }

// Response (200)
{ "accessToken": "<jwt>", "refreshToken": "<new-jwt>" }
```

**`GET /api/auth/me`** (Header: `Authorization: Bearer <accessToken>`)
```json
// Response (200)
{ "id": "...", "name": "...", "email": "...", "role": "...", "permissions": [...] }
```

### Users

**`POST /api/users`** — `users:create`
```json
// Request
{ "name": "John Doe", "email": "john@example.com", "password": "secret123", "role": "<roleId>" }

// Response (201)
{ "_id": "...", "name": "...", "email": "...", "role": "...", "isActive": true, ... }
```

**`GET /api/users`** — `users:read`
```json
// Response (200)
[{ "_id": "...", "name": "...", "email": "...", "role": { ... }, ... }]
```

**`PUT /api/users/:id`** — `users:update`
```json
// Request body (partial)
{ "name": "...", "role": "<roleId>", "isActive": false }
```

**`DELETE /api/users/:id`** — `users:delete`
```json
// Response (200)
{ "message": "User deleted" }
```

### Roles

**`POST /api/roles`** — `role:manage`
```json
// Request
{ "name": "service_engineer", "description": "Field service engineer", "permissions": ["report:read"] }
```

**`GET /api/roles`** — `role:manage`
**`GET /api/roles/:id`** — `role:manage`
**`PUT /api/roles/:id`** — `role:manage`
**`DELETE /api/roles/:id`** — `role:manage` (fails if `isSystem` or in use by users)

### Permissions

**`GET /api/permissions`** — `permission:manage` — catalog of all unique permissions across roles
**`GET /api/permissions/roles`** — `permission:manage` — all roles with their permissions
**`POST /api/permissions/roles/:roleId/grant`** — `permission:manage` — add permissions
**`DELETE /api/permissions/roles/:roleId/revoke/:permission`** — `permission:manage` — remove one permission
**`PUT /api/permissions/roles/:roleId/set`** — `permission:manage` — replace entire permissions array

---

## Audit Logging

A dedicated `AuditLog` model records every security-sensitive event. The `auditLog()` helper (`utils/audit.js`) is fire-and-forget — failures never break the main request flow.

### Captured Fields

| Field | Description |
|-------|-------------|
| `actor` | User ID who performed the action (ref `User`) |
| `action` | Event name, e.g. `user:create`, `role:update`, `permission:grant` |
| `targetType` | `User` or `Role` |
| `targetId` | ID of the affected resource |
| `outcome` | `success` or `failure` |
| `details` | Mixed — before/after values, changed fields, attempted role, etc. |
| `ip` | Requester IP address |
| `userAgent` | Requester User-Agent header |
| `createdAt` | Timestamp (auto) |

### Audited Events

| Action | Triggered On | Outcome |
|--------|-------------|---------|
| `user:create` | `POST /api/users` | success + failure |
| `user:update` | `PUT /api/users/:id` | success + failure |
| `user:delete` | `DELETE /api/users/:id` | success |
| `role:create` | `POST /api/roles` | success + failure |
| `role:update` | `PUT /api/roles/:id` | success + failure |
| `role:delete` | `DELETE /api/roles/:id` | success |
| `permission:grant` | `POST /api/permissions/roles/:id/grant` | success + failure |
| `permission:revoke` | `DELETE /api/permissions/roles/:id/revoke/:perm` | success |
| `permission:set` | `PUT /api/permissions/roles/:id/set` | success + failure |

### Query Example

```js
// All failed security events
await AuditLog.find({ outcome: 'failure' }).sort({ createdAt: -1 });

// All actions by a specific admin
await AuditLog.find({ actor: adminUserId }).sort({ createdAt: -1 });
```

---

## Security & Privilege Escalation Protection

### User Creation (`POST /api/users`)
- Route-level: requires `users:create` permission (Admin via `*`, Technical Manager via explicit grant).
- Controller-level: **Technical Managers can only create users with the `service_engineer` role.** Any other target role returns `403`.
- Role ID is validated against MongoDB before assignment.

### User Update (`PUT /api/users/:id`)
- Route-level: requires `users:update` (Admin only).
- **Self role-change is blocked** — a user cannot change their own `role`.
- **Non-admin cannot assign privileged roles** (`admin`, `technical_manager`) to any user.
- Role ID is validated against MongoDB if present.
- Deactivation (`isActive: false`) is audited with the changed field recorded.

### User Deletion (`DELETE /api/users/:id`)
- Route-level: requires `users:delete` (Admin only).
- **Self-deletion is blocked.**

### Role Management (`/api/roles`)
- Route-level: requires `role:manage` (Admin only).
- Non-admin cannot create or update a role with the `["*"]` wildcard permission.
- System roles (`isSystem: true`) cannot be renamed or deleted.
- Roles in use by users cannot be deleted.

### Permission Management (`/api/permissions`)
- Route-level: requires `permission:manage` (Admin only).
- Non-admin cannot grant or set the `["*"]` wildcard permission on any role.

### Token Security
- Refresh tokens are hashed (SHA-256) before storage.
- Refresh-token rotation on every `/refresh` call.
- Reuse detection: if a refresh token is presented twice, all tokens for that user are revoked.
- TTL index on `RefreshToken.expiresAt` auto-removes expired tokens.

---

## Error Handling

Centralized error handler in `index.js`:

| Error | Status | Response |
|-------|--------|----------|
| Duplicate key (11000) | 409 | `{ message: "Duplicate value", fields: { ... } }` |
| Mongoose ValidationError | 400 | `{ message: err.message }` |
| Mongoose CastError | 400 | `{ message: "Invalid <path>" }` |
| Generic | `err.status` or 500 | `{ message: err.message || "Server error" }` |

404 route handler returns `{ message: "Route not found" }`.

---

## Available Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `dev` | `nodemon index.js` | Start development server with auto-reload |
| `seed` | `node seed.js` | Seed database (admin role + admin user) |

---

## License

ISC

