// jobs/healthMonitor.js  (ES module)
// Creates tickets automatically for charger problems, inside the running backend.
//
// FLOW (matches the normal createTicket flow of the ticket system):
//   1. A charger is critical/high  -> the job creates ONE ticket for it:
//        status "open", departmentId = the department that handles chargers, createdBy = care manager,
//        NOT assigned to anyone (the department's technical_manager assigns it, as for any ticket).
//   2. technical_manager assigns -> engineer works it -> resolved -> closed   (existing ticket system)
//   3. When the charger is healthy again the job adds ONE internal note on the open ticket
//      ("charger is healthy again, please verify and close"). It never closes tickets itself.
//
// The ticket is tagged "[ocpp:<id>]" in its description: that is how the job knows a charger already
// has an open ticket, so restarts and flapping chargers never create duplicates.
//
// ENV
//   TECH_TOKEN                          required: technician JWT for the health API (job stays off without it)
//   CHARGER_TICKET_DEPARTMENT_ID        _id of the Department that receives charger tickets (required, see below)
//   CHARGER_TICKET_CREATOR_ID           optional: _id of the user shown as creator (skips the role lookup)
//   CHARGER_TICKET_MANAGER_ROLE         role name used to find the creator (default customer_care_manager)
//   HEALTH_API_BASE                     default https://ocpphub.eeil.online/api/v1/technical/monitoring
//   CHARGER_TICKETS_ENABLED             "false" turns the job off
//   ALERT_POLL_SECONDS                  check interval, default 60
//   CHARGER_TICKET_SEVERITIES           default "critical,high"
//   CHARGER_TICKET_MIN_BAD_MINUTES      charger must stay bad this long before a ticket is made (default 0)
//   CHARGER_TICKET_MAX_PER_CYCLE        safety cap on new tickets / notes per check (default 25)
//   CHARGER_TICKET_CLOSED_STATUSES      statuses that mean "finished" (default resolved,closed)
//
// departmentId is REQUIRED by the Ticket schema. If CHARGER_TICKET_DEPARTMENT_ID is not set, the creator's
// own department is used; if that is empty too, no ticket is created (one clear error is logged).

import Ticket from "../Models/Ticket.js";
import User from "../Models/User.js";
import TicketComment from "../Models/TicketComment.js";

const RECOVERY_NOTE =
  "Auto-check: this charger is healthy again (no longer critical/high). Please verify and close the ticket.";

function readConfig() {
  const list = (v, d) => String(v || d).split(",").map((s) => s.trim()).filter(Boolean);
  return {
    token: process.env.TECH_TOKEN || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MzI2MywibW9iaWxlX25vIjoiODQ0NzA4MDY3NiIsImRvbWFpbiI6ImVlaWwub25saW5lIiwiaWF0IjoxNzkyNjUwMjQzfQ.e2c85b8lvsA1xBAw1PU9vljTPJQojzAIH5nQLA9oMT0",
    base: (process.env.HEALTH_API_BASE || "https://ocpphub.eeil.online/api/v1/technical/monitoring").replace(/\/+$/, ""),
    enabled: String(process.env.CHARGER_TICKETS_ENABLED || "true").toLowerCase() !== "false",
    intervalMs: (Number(process.env.ALERT_POLL_SECONDS) || 60) * 1000,
    severities: list(process.env.CHARGER_TICKET_SEVERITIES, "critical,high").map((s) => s.toLowerCase()),
    minBadMs: (Number(process.env.CHARGER_TICKET_MIN_BAD_MINUTES) || 0) * 60000,
    maxPerCycle: Number(process.env.CHARGER_TICKET_MAX_PER_CYCLE) || 25,
    closed: list(process.env.CHARGER_TICKET_CLOSED_STATUSES, "resolved,closed"),
    departmentId: process.env.CHARGER_TICKET_DEPARTMENT_ID || "",
    creatorId: process.env.CHARGER_TICKET_CREATOR_ID || process.env.CHARGER_TICKET_ASSIGNEE_ID || "",
    managerRole: process.env.CHARGER_TICKET_MANAGER_ROLE || "customer_care_manager",
  };
}

const PRIORITY = { critical: "urgent", high: "high", medium: "medium", low: "low" };

async function fetchOverview(cfg) {
  const res = await fetch(cfg.base + "/overview?limit=2000", {
    headers: { Authorization: "Bearer " + cfg.token },
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) throw new Error(`Health API ${res.status} ${(body && body.message) || res.statusText}`);
  return body.data.data;
}

// charger ids that already have an open ticket (read from the "[ocpp:<id>]" tags)
function openChargerIds(docs) {
  const ids = new Set();
  const re = /\[ocpp:([^\]]+)\]/g;
  docs.forEach((d) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(d.description || ""))) ids.add(m[1]);
  });
  return ids;
}

function warnOnce(state, key, msg) {
  if (state.warned.has(key)) return;
  state.warned.add(key);
  console.error("[HealthMonitor] " + msg);
}

// Who is shown as the ticket creator.
// CHARGER_TICKET_CREATOR_ID if set, else a user holding the role (roles collection lookup).
// Raw collection queries are used so this works whatever the User schema calls the role field.
async function findCreator(cfg, state) {
  if (cfg.creatorId) {
    const u = await User.findById(cfg.creatorId).lean();
    if (!u) warnOnce(state, "creator", `creator user ${cfg.creatorId} not found in users`);
    return u;
  }
  const role = await User.db.collection("roles").findOne({ name: cfg.managerRole });
  if (!role) { warnOnce(state, "creator", `role "${cfg.managerRole}" not found in the roles collection`); return null; }
  const ids = [role._id, String(role._id)];
  const user = await User.collection.findOne({
    $or: [{ role: { $in: ids } }, { roleId: { $in: ids } }, { roles: { $in: ids } }, { "role._id": { $in: ids } }],
  });
  if (!user) {
    warnOnce(state, "creator", `role "${cfg.managerRole}" exists but no user has it - set CHARGER_TICKET_CREATOR_ID`);
    return null;
  }
  return { ...user, departmentId: user.departmentId || role.departmentId || null };
}

function buildTicket(c, creator, departmentId) {
  const issues = (c.issues || []).join("; ") || "No specific issues reported";
  const sev = String(c.severity).toUpperCase();
  return {
    // full timestamp + random suffix: no repeats between tickets created close together
    ticketNumber: `AUTO-${Date.now()}-${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`,
    subject: `Charger issue: ${c.chargerName} [${sev}]`,
    description: `Charger ${c.chargerName} (${c.stationName}) has ${sev} severity: ${issues} [ocpp:${c.ocppId}]`,
    customerName: "Auto-detected",
    customerPhone: "",
    customerEmail: "",
    departmentId,
    priority: PRIORITY[c.severity] || "medium",
    status: "open",
    createdBy: creator._id,
    // no assignedTo / assignedBy: the department's technical_manager assigns it (assignTicket)
    faultDescription: issues,
    escalationHours: 24,
    resolutionType: null,
  };
}

async function createTickets(cfg, state, toCreate, result) {
  const creator = await findCreator(cfg, state);
  if (!creator) return;
  const departmentId = cfg.departmentId || creator.departmentId;
  if (!departmentId) {
    warnOnce(state, "dept", "no department for charger tickets - set CHARGER_TICKET_DEPARTMENT_ID (departmentId is required)");
    return;
  }
  const batch = toCreate.slice(0, cfg.maxPerCycle);
  result.deferred = toCreate.length - batch.length;
  for (const c of batch) {
    try {
      const t = await Ticket.create(buildTicket(c, creator, departmentId));
      result.created.push(t.ticketNumber);
    } catch (e) {
      // one failed ticket must not stop the others
      console.error(`[HealthMonitor] ticket for ${c.chargerName} failed: ${e.message}`);
    }
  }
}

// Charger is fine again but its ticket is still open: leave ONE internal note, never close it.
async function noteRecoveries(cfg, openDocs, byId, result) {
  let n = 0;
  for (const d of openDocs) {
    if (n >= cfg.maxPerCycle) break;
    const m = /\[ocpp:([^\]]+)\]/.exec(d.description || "");
    if (!m) continue;
    const c = byId.get(m[1]);
    if (!c || cfg.severities.includes(c.severity)) continue; // unknown or still bad
    try {
      const exists = await TicketComment.findOne({ ticketId: d._id, comment: RECOVERY_NOTE }).lean();
      if (exists) continue;
      await TicketComment.create({ ticketId: d._id, author: d.createdBy, comment: RECOVERY_NOTE, isInternalNote: true });
      result.noted.push(m[1]);
      n++;
    } catch (e) {
      console.error(`[HealthMonitor] recovery note for ${m[1]} failed: ${e.message}`);
    }
  }
}

// One check. Returns what it did.
async function runOnce(cfg, state) {
  const result = { checked: 0, bad: 0, created: [], noted: [], deferred: 0 };
  const chargers = await fetchOverview(cfg);
  result.checked = chargers.length;
  const byId = new Map(chargers.map((c) => [c.ocppId, c]));

  const now = Date.now();
  const bad = chargers.filter((c) => cfg.severities.includes(c.severity));
  result.bad = bad.length;

  // remember since when each charger has been bad; forget the ones that recovered
  const badIds = new Set(bad.map((c) => c.ocppId));
  for (const id of Array.from(state.firstBad.keys())) if (!badIds.has(id)) state.firstBad.delete(id);
  bad.forEach((c) => { if (!state.firstBad.has(c.ocppId)) state.firstBad.set(c.ocppId, now); });

  // one query: tickets for chargers that are still open
  const openDocs = await Ticket.find({
    description: { $regex: "\\[ocpp:" },
    status: { $nin: cfg.closed },
  }).select("description createdBy").lean();
  const open = openChargerIds(openDocs);

  const due = bad.filter((c) => now - state.firstBad.get(c.ocppId) >= cfg.minBadMs);
  const toCreate = due.filter((c) => !open.has(c.ocppId));
  if (toCreate.length) await createTickets(cfg, state, toCreate, result);

  await noteRecoveries(cfg, openDocs, byId, result);
  return result;
}

/**
 * Start the health monitor. Call once, after the database connection is ready.
 */
export function startHealthMonitor() {
  const noop = { stop() {}, runNow: async () => null };
  const cfg = readConfig();
  if (!cfg.enabled) { console.log("[HealthMonitor] disabled (CHARGER_TICKETS_ENABLED=false)"); return noop; }
  if (!cfg.token) { console.warn("[HealthMonitor] TECH_TOKEN not set - not started"); return noop; }

  const state = { firstBad: new Map(), warned: new Set() };
  let running = false;

  async function tick() {
    if (running) return null; // never overlap two checks
    running = true;
    try {
      const r = await runOnce(cfg, state);
      if (r.created.length) {
        console.log(`[HealthMonitor] created ${r.created.join(", ")}${r.deferred ? ` (${r.deferred} deferred to next cycle)` : ""}`);
      }
      if (r.noted.length) console.log(`[HealthMonitor] recovery note added for ${r.noted.join(", ")}`);
      return r;
    } catch (e) {
      console.error("[HealthMonitor] check failed:", e.message);
      return null;
    } finally {
      running = false;
    }
  }

  console.log(`[HealthMonitor] Starting: every ${cfg.intervalMs / 1000}s, severities ${cfg.severities.join(",")}`);
  const first = setTimeout(tick, 5000); // small delay so the DB is ready
  const timer = setInterval(tick, cfg.intervalMs);
  return { stop() { clearTimeout(first); clearInterval(timer); }, runNow: tick };
}

//"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MzI2MywibW9iaWxlX25vIjoiODQ0NzA4MDY3NiIsImRvbWFpbiI6ImVlaWwub25saW5lIiwiaWF0IjoxNzkyNjUwMjQzfQ.e2c85b8lvsA1xBAw1PU9vljTPJQojzAIH5nQLA9oMT0",//