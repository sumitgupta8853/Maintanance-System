import Ticket from "../Models/Ticket.js";
import User from "../Models/User.js";
import TicketComment from "../Models/TicketComment.js";

const RECOVERY_NOTE =
  "Auto-check: this charger is healthy again (no longer critical/high). Please verify and close the ticket.";

function readConfig() {
  const list = (v, d) => String(v || d).split(",").map((s) => s.trim()).filter(Boolean);
  return {
    token: process.env.TECH_TOKEN || "",
    base: (process.env.HEALTH_API_BASE || "https://ocpphub.eeil.online/api/v1/technical/monitoring").replace(/\/+$/, ""),
    enabled: String(process.env.CHARGER_TICKETS_ENABLED || "true").toLowerCase() !== "false",
    intervalMs: (Number(process.env.ALERT_POLL_SECONDS) || 60) * 1000,
    severities: list(process.env.CHARGER_TICKET_SEVERITIES, "critical,high").map((s) => s.toLowerCase()),
    categories: list(process.env.CHARGER_TICKET_CATEGORIES, "active_issue").map((s) => s.toLowerCase()),
    minBadMs: (process.env.CHARGER_TICKET_MIN_BAD_MINUTES === undefined || process.env.CHARGER_TICKET_MIN_BAD_MINUTES === ""
      ? 10 : Number(process.env.CHARGER_TICKET_MIN_BAD_MINUTES) || 0) * 60000,
    maxPerCycle: Number(process.env.CHARGER_TICKET_MAX_PER_CYCLE) || 25,
    // after a ticket for a charger is closed, no new ticket for it during this time (0 = off)
    cooldownMs: (process.env.CHARGER_TICKET_COOLDOWN_HOURS === undefined || process.env.CHARGER_TICKET_COOLDOWN_HOURS === ""
      ? 2 : Number(process.env.CHARGER_TICKET_COOLDOWN_HOURS) || 0) * 3600000,
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
    signal: AbortSignal.timeout(30000), // a stuck request must not freeze the job forever
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) throw new Error(`Health API ${res.status} ${(body && body.message) || res.statusText}`);
  const d = body.data;
  if (d.pagination && d.pagination.hasMore) {
    throw new Error("Health API has more than 2000 chargers; raise the page limit before creating tickets (incomplete data)");
  }
  return { chargers: d.data, warnings: d.warnings || [] };
}

// A charger gets a ticket only when it is bad AND a real, current problem (not long-offline / stale label).
function isTicketable(cfg, c) {
  return cfg.severities.includes(c.severity) && cfg.categories.includes(c.category || "active_issue");
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
  const off = c.offlineFor ? ` Offline for ${c.offlineFor}.` : "";
  return {
    // full timestamp + random suffix: no repeats between tickets created close together
    ticketNumber: `AUTO-${Date.now()}-${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`,
    subject: `Charger issue: ${c.chargerName} [${sev}]`,
    description: `Charger ${c.chargerName} (${c.stationName}) has ${sev} severity: ${issues}.${off} [ocpp:${c.ocppId}]`,
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
    if (!c || isTicketable(cfg, c) || c.category === "long_offline") continue; // unknown, still bad, or still offline
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
  const result = { checked: 0, bad: 0, created: [], noted: [], deferred: 0, skipped: null };
  const fetched = await fetchOverview(cfg);
  // if the monitoring data is incomplete, do nothing: wrong data must never create or note tickets
  if (fetched.warnings.length) { result.skipped = fetched.warnings.join("; "); return result; }
  const chargers = fetched.chargers.filter((c) => c.ocppId);
  // Old Health API (no "category" field): every long-dead charger would look like a new problem and get a ticket.
  // Never create tickets from that response.
  if (chargers.length && !chargers.some((c) => c.category)) {
    result.skipped = "Health API response has no category field (old version); deploy the updated monitoring first";
    return result;
  }
  result.checked = chargers.length;
  const byId = new Map(chargers.map((c) => [c.ocppId, c]));

  const now = Date.now();
  const bad = chargers.filter((c) => isTicketable(cfg, c));
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
  // chargers whose ticket was closed a moment ago: wait before opening another one
  let cooling = new Set();
  if (cfg.cooldownMs > 0) {
    if (Ticket.schema && Ticket.schema.paths && Ticket.schema.paths.updatedAt) {
      const recent = await Ticket.find({
        description: { $regex: "\\[ocpp:" },
        status: { $in: cfg.closed },
        updatedAt: { $gte: new Date(now - cfg.cooldownMs) },
      }).select("description").lean();
      cooling = openChargerIds(recent);
    } else {
      warnOnce(state, "cooldown", "Ticket schema has no updatedAt field - cooldown after closing is disabled");
    }
  }
  const toCreate = due.filter((c) => !open.has(c.ocppId) && !cooling.has(c.ocppId));
  if (toCreate.length) await createTickets(cfg, state, toCreate, result);

  await noteRecoveries(cfg, openDocs, byId, result);
  return result;
}

/**
 * Start the health monitor. Call once, after the database connection is ready.
 */
export function startHealthMonitor() {
  const noop = { stop() { }, runNow: async () => null };
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
      if (r.skipped) console.warn("[HealthMonitor] skipped this cycle: " + r.skipped);
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

  console.log(`[HealthMonitor] Starting: every ${cfg.intervalMs / 1000}s, severities ${cfg.severities.join(",")}, categories ${cfg.categories.join(",")}, min bad ${cfg.minBadMs / 60000}m, cooldown ${cfg.cooldownMs / 3600000}h`);
  const first = setTimeout(tick, 5000); // small delay so the DB is ready
  const timer = setInterval(tick, cfg.intervalMs);
  return { stop() { clearTimeout(first); clearInterval(timer); }, runNow: tick };
}