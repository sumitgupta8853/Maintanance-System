import { Router } from "express";
import mongoose from "mongoose";
import Ticket from "../Models/Ticket.js";
import { authenticate } from "../middlewares/auth.js";
import { logger } from "../utils/logger.js";
import { selfAssignTicket } from "../controller/assignmentRequest.controller.js";

const list = (v, d) => String(v || d).split(",").map((s) => s.trim()).filter(Boolean);

const cfg = () => ({
  base: (process.env.HEALTH_API_BASE || "https://ocpphub.eeil.online/api/v1/technical/monitoring").replace(/\/+$/, ""),
  token: process.env.TECH_TOKEN || "",
  closed: list(process.env.CHARGER_TICKET_CLOSED_STATUSES, "resolved,closed"),
  roles: list(process.env.NEARBY_TICKET_ROLES, "admin,technical_manager,service_engineer"),
});

// charger locations hardly change, so keep them for 5 minutes
let cache = { at: 0, map: null };
let inflight = null;

async function fetchLocations() {
  const c = cfg();
  const r = await fetch(c.base + "/overview?limit=2000", {
    headers: { Authorization: "Bearer " + c.token },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`hub answered ${r.status}`);
  const body = await r.json();
  const chargers = Array.isArray(body.data) ? body.data : body.data?.data;
  if (!Array.isArray(chargers)) throw new Error("unexpected hub response");
  const map = new Map();
  for (const ch of chargers) {
    if (!ch.ocppId || ch.latitude === null || ch.longitude === null || ch.latitude === "" || ch.longitude === "") continue;
    const lat = Number(ch.latitude), lng = Number(ch.longitude);
    if (!validCoords(lat, lng) || (lat === 0 && lng === 0)) continue;
    map.set(ch.ocppId, { lat, lng, stationName: ch.stationName, chargerName: ch.chargerName, city: ch.city });
  }
  return map;
}

async function getLocations() {
  if (cache.map && Date.now() - cache.at < 300000) return cache.map;
  try {
    inflight ||= fetchLocations().finally(() => { inflight = null; });
    cache = { map: await inflight, at: Date.now() };
  } catch (e) {
    if (!cache.map) throw e;
    logger.error({ component: "NearbyTickets", err: e }, `using old locations: ${e.message}`);
  }
  return cache.map;
}

function validCoords(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

// straight-line distance in km
function distanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const ocppIdOf = (t) => /\[ocpp:([^\]]+)\]/.exec(t.description || "")?.[1];

// cursor = position of the last ticket already sent (plus the search point of page 1)
const encodeCursor = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function decodeCursor(v) {
  try {
    const o = JSON.parse(Buffer.from(String(v), "base64url").toString("utf8"));
    return o && Number.isFinite(o.km) && typeof o.id === "string" && validCoords(o.lat, o.lng) ? o : null;
  } catch (e) {
    return null;
  }
}
// sort order: distance, then id (so tickets at the same station have a fixed order)
const compare = (a, b) => a.km - b.km || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// add &cursor=<nextCursor> for the following page
// GET /nearby?ticketId=...   (around the station of my assigned ticket)
// GET /nearby?lat=..&lng=..  (around my current position)
export async function nearbyTickets(req, res) {
  const c = cfg();
  const role = req.user?.role?.name;
  if (!c.roles.includes(role)) return res.status(403).json({ message: "You do not have access to nearby tickets" });
  if (!c.token) return res.status(503).json({ message: "Nearby tickets is not configured on the server" });

  const num = (v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
  const radius = Math.min(100, num(req.query.radius) > 0 ? num(req.query.radius) : 10); // km
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const { ticketId } = req.query;

  let cursor = null;
  if (req.query.cursor !== undefined && req.query.cursor !== "") {
    cursor = decodeCursor(req.query.cursor);
    if (!cursor) return res.status(400).json({ message: "Invalid cursor" });
  }

  // later pages keep the search point of page 1, even if the engineer has moved
  let from = cursor ? { lat: cursor.lat, lng: cursor.lng } : { lat: num(req.query.lat), lng: num(req.query.lng) };
  if (ticketId !== undefined) {
    if (!mongoose.isValidObjectId(ticketId)) return res.status(400).json({ message: "Invalid ticketId" });
  } else if (!validCoords(from.lat, from.lng)) {
    return res.status(400).json({ message: "Send ticketId, or valid lat and lng" });
  }

  try {
    const locations = await getLocations();

    if (ticketId !== undefined) {
      const mine = await Ticket.findById(ticketId).lean();
      const userId = String(req.user._id || req.user.id);
      // engineers can only search around their own ticket
      if (!mine || (role === "service_engineer" && String(mine.assignedTo?._id || mine.assignedTo) !== userId)) {
        return res.status(404).json({ message: "Ticket not found" });
      }
      from = locations.get(ocppIdOf(mine));
      if (!from) return res.status(422).json({ message: "No location found for this ticket's charger" });
    }

    const open = await Ticket.find({
      type: "auto",
      assignedTo: null, // matches both null and not set
      status: { $nin: c.closed },
    }).lean();

    let noLocation = 0;
    const tickets = [];
    for (const t of open) {
      const p = locations.get(ocppIdOf(t));
      if (!p) { noLocation++; continue; }
      const km = distanceKm(from, p);
      if (km > radius) continue;
      tickets.push({
        km, // exact distance, used only for sorting and the cursor
        id: String(t._id),
        ticketNumber: t.ticketNumber,
        subject: t.subject,
        description: t.description,
        priority: t.priority,
        status: t.status,
        createdAt: t.createdAt,
        recovered: !!t.recoveredAt,
        stationName: p.stationName,
        chargerName: p.chargerName,
        city: p.city,
        latitude: p.lat,
        longitude: p.lng,
        distanceKm: Math.round(km * 100) / 100,
      });
    }
    tickets.sort(compare);

    const rest = cursor ? tickets.filter((t) => compare(t, cursor) > 0) : tickets;
    const page = rest.slice(0, limit);
    const hasMore = rest.length > page.length;
    const last = page[page.length - 1];

    return res.json({
      tickets: page.map(({ km, ...t }) => t),
      pagination: {
        limit,
        hasMore,
        nextCursor: hasMore ? encodeCursor({ km: last.km, id: last.id, lat: from.lat, lng: from.lng }) : null,
      },
      total: tickets.length,
      radiusKm: radius,
      withoutLocation: noLocation,
    });
  } catch (e) {
    logger.error({ component: "NearbyTickets", err: e }, `nearby tickets failed: ${e.message}`);
    return res.status(500).json({ message: "Could not find nearby tickets" });
  }
}

const router = Router();
router.get("/nearby", authenticate, nearbyTickets);

router.post("/:ticketId/self-assign", authenticate, selfAssignTicket);

export default router;