# Support Ticket System Guide

## Overview

The **Support Ticket System** is a full-featured ticket tracking system built into the Maintenance Backend. It handles ticket creation, assignment, status progression, commenting, history tracking, and role-based access control.

**Base URL:** `http://localhost:5000/api/support/tickets`

---

## Authentication

All ticket endpoints require JWT authentication. Obtain a token by logging in:

```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "your-email@example.com",
  "password": "your-password"
}
```

**Response:**

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "6adf180c5f26bc843c6e9d91",
    "name": "CC Executive",
    "email": "ccexec@test.com",
    "role": {
      "name": "cc_executive",
      "permissions": ["ticket:create", "ticket:view"]
    }
  }
}
```

**Include token:** `Authorization: Bearer <accessToken>` header on every request.

---

## API Endpoints

| Method | Route | Permission | Description |
|---|---|---|---|
| `POST` | `/` | `ticket:create` | Create a new ticket |
| `GET` | `/manager` | `ticket:view_department` | Tickets in manager's department |
| `GET` | `/manager/:id` | `ticket:view_department` | One ticket in manager's department |
| `POST` | `/manager/:id/assign` | `ticket:assign` | Assign ticket to user |
| `GET` | `/team` | `ticket:view_assigned` | Tickets assigned to me |
| `PATCH` | `/team/:id/status` | `ticket:update_status` | Update ticket status |
| `GET` | `/all` | `ticket:view` | Every ticket user can see (scope-filtered) |
| `GET` | `/:id` | `ticket:view` | Single ticket detail |
| `PATCH` | `/:id` | `ticket:edit` | Edit ticket fields |
| `GET` | `/:id/history` | `ticket:view` | Status + field history |
| `GET` | `/:id/comments` | `ticket:view` | Comments (oldest first) |
| `POST` | `/:id/comments` | `ticket:comment` | Add comment |
| `POST` | `/:id/close` | `ticket:close` | Close a resolved ticket |

## Route Ordering (Critical)

Routes must be declared **in this order** — Express matches top-to-bottom:

```
/manager → /manager/:id → /team → /all → / (create) → /:id → /:id/history → /:id/comments → /:id/close
```

**Why:** Without this ordering, Express would treat `/manager`, `/all`, etc. as ticket IDs (`/:id`) and never reach the intended handlers.

## Status Workflow

```
open → assigned → in_progress → resolved → closed
```

| From → To | Allowed By | Notes |
|---|---|---|
| `open → assigned` | technical_manager | Blocked if ticket is resolved/closed |
| `assigned → in_progress` | assigned service_engineer | |
| `in_progress → resolved` | assigned service_engineer | |
| `resolved → in_progress` | assigned service_engineer | Reopens a resolved ticket |
| `resolved → closed` | technical_manager or service_engineer (assignedTo match) | |
| **any → closed** | **admin** (`permissions: *`) | Admin can close from any status |
| `closed` → (any) | **none** | Closed tickets cannot be edited (except admin) |

**Transition enforcement:**
- If `permissions.includes('*')` → admin (full access)
- If `roleName === 'technical_manager'` → can close resolved tickets
- If `roleName === 'service_engineer'` → can only close tickets assigned to them
- Status `resolved` → `closed` requires explicit close action

## Permission Reference

| Permission | Meaning | Typically For |
|---|---|---|
| `ticket:create` | Can create tickets | cc_executive, tech_manager, admin |
| `ticket:view` | Can view tickets (scope-filtered) | All roles |
| `ticket:view_department` | Can view dept tickets | technical_manager |
| `ticket:view_assigned` | Can view assigned tickets | service_engineer |
| `ticket:update_status` | Can update status | service_engineer, technical_manager |
| `ticket:edit` | Can edit ticket fields | technical_manager, admin |
| `ticket:assign` | Can assign tickets | technical_manager |
| `ticket:comment` | Can add comments | All roles with view access |
| `ticket:close` | Can close tickets | technical_manager, service_engineer (assigned tickets only), admin |


## Real-World Workflow Example

### 1. CC Executive Creates a Ticket

```http
POST /api/support/tickets
Authorization: Bearer <cc_exec_token>
Content-Type: application/json

{
  "subject": "Website down",
  "description": "Homepage returns 500 error",
  "customerName": "Acme Corp",
  "customerEmail": "contact@acme.com",
  "departmentId": "6adefc9f0dda706b15e57fa8"
}
```

**Response:** `201` + ticket object with `ticketNumber: "TKT-566884"`, `status: "open"`

### 2. Technical Manager Views Department Tickets

```http
GET /api/support/tickets/manager
Authorization: Bearer <tech_mgr_token>
```

**Response:** List of tickets in engineering department, scoped to what the manager can see.

### 3. Technical Manager Assigns Ticket

```http
POST /api/support/tickets/manager/:id/assign
Authorization: Bearer <tech_mgr_token>
Content-Type: application/json

{
  "assignedTo": "6adf180c5f26bc843c6e9d8f"
}
```

**Response:** Ticket now has `assignedTo` set and status changes to `assigned`.

### 4. Service Engineer Updates Status

```http
PATCH /api/support/tickets/team/:id/status
Authorization: Bearer <svceng_token>
Content-Type: application/json

{
  "status": "in_progress"
}
```

**Response:** Ticket status updated; history recorded.

### 5. Service Engineer Adds Comment

```http
POST /api/support/tickets/:id/comments
Authorization: Bearer <svceng_token>
Content-Type: application/json

{
  "comment": "Investigating the root cause...",
  "isInternalNote": false
}
```

**Response:** `201` + comment object with author info.

### 6. Technical Manager Closes Ticket

```http
POST /api/support/tickets/:id/close
Authorization: Bearer <tech_mgr_token>
```

**Response:** Ticket status = `closed`, `closedAt` set, history + audit log written.

## Error Codes

| Status | Meaning | Resolution |
|---|---|---|
| `400` | Missing fields, invalid transition, bad request | Check request body; verify status transition is valid |
| `403` | Out of permission (not authorized) | Check role permissions; ensure required permission granted |
| `404` | Ticket not found **or** out of scope | 404 is intentional (doesn't distinguish "not found" from "no access") to prevent ID probing |
| `409` | Duplicate ticket number (race condition) | Controller retries automatically up to 5 times before returning 409 |
| `500` | Server error | Contact admin; check MongoDB logs |

**Note:** `404` is used for both "ticket doesn't exist" AND "ticket out of scope" — this is intentional to prevent attackers from probing which ticket IDs exist.

## Audit Logging

Every status change and field edit writes to:

1. **TicketHistory** collection (type, field, oldValue, newValue, changedBy, note)
2. **AuditLog** (actor, action, target, targetType, outcome, details, ip, userAgent)

**Audit events tracked:**
- `ticket:create`, `ticket:update_status`, `ticket:close`, `ticket:comment`, `ticket:edit`
- All mutations include `ticketNumber`, `changedBy`, `outcome: success/failure`

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| `404 "Ticket not found"` on valid ID | Ticket exists but user out of scope | Verify user role/department; use `/all` to check visibility |
| `403 "Only technical_manager can assign"` | Wrong role assigned to user | User must have role `technical_manager` and `ticket:assign` permission; permission alone is not enough |
| `400 "Ticket must be resolved before closing"` | Status transition invalid | Transition: `assigned → in_progress → resolved → closed` |
| `404` on `/manager/:id` but works on `/all` | User has no department assigned | Ensure user has `departmentId` set; or use `/all` route |
| Comments not appearing | Missing `ticket:comment` permission | Grant permission or check role |

## Development Notes (for engineers)

- **Route order is critical** — see `routes/ticket.Routes.js` line 26-27 comment
- **`ticketInScope()`** handles both raw ObjectIds and populated documents (via `getId()` helper)
- **`ticketAccessFilter()`** builds MongoDB `$or` filter: `{createdBy} ∪ {assignedTo} ∪ {departmentId}`
- **Admin wildcard `*`** bypasses all scope checks
- **History + Audit** are fire-and-forget — failures never break the main request; failures are logged to stderr
- **Status transitions** are enforced in `closeTicket()` and `updateStatus()` controllers
- **Comments** use `author: user._id`; internal notes flagged via `isInternalNote: true`

## Quick-Start Commands

```bash
# 1. Start server
cd /Users/rajpalyadav/Sumit-Backend/Maintainance-System
npm run dev

# 2. Login as CC Executive
curl -s -X POST http://localhost:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"ccexec@test.com","password":"Password123"}'

# 3. Create a ticket (use returned accessToken)
curl -s -X POST http://localhost:5000/api/support/tickets \
  -H "Authorization: Bearer <TOKEN>" \
  -H 'Content-Type: application/json' \
  -d '{"subject":"Debug Ticket","departmentId":"6adefc9f0dda706b15e57fa8"}'

# 4. View all tickets user can see
curl -s http://localhost:5000/api/support/tickets/all \
  -H "Authorization: Bearer <TOKEN>"

# 5. Assign ticket (as technical_manager)
curl -s -X POST http://localhost:5000/api/support/tickets/manager/:id/assign \
  -H "Authorization: Bearer <MGR_TOKEN>" \
  -H 'Content-Type: application/json' \
  -d '{"assignedTo":"<ENGINEER_ID>"}'

# 6. Close ticket (as tech manager on resolved ticket)
curl -s -X POST http://localhost:5000/api/support/tickets/:id/close \
  -H "Authorization: Bearer <MGR_TOKEN>"
```

---
**Include token:** `Authorization: Bearer <accessToken>` header on every request.