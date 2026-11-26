import { Router } from "express";
import { authenticate } from "../middlewares/auth.js";
import { logger } from "../utils/logger.js";

const cfg = () => ({
  base: (process.env.HEALTH_API_BASE || "https://ocpphub.eeil.online/api/v1/technical/monitoring").replace(/\/+$/, ""),
  token: process.env.TECH_TOKEN || "",
});

const TTL_MS = 30000;
let cache = { at: 0, chargers: null };
let inflight = null;

async function fetchChargers() {
  const c = cfg();
  const r = await fetch(c.base + "/overview?limit=2000", {
    headers: { Authorization: "Bearer " + c.token },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`hub answered ${r.status}`);
  const body = await r.json();
  const list = Array.isArray(body.data) ? body.data : body.data?.data;
  if (!Array.isArray(list)) throw new Error("unexpected hub response");
  if (body.data?.pagination?.hasMore) logger.error({ component: "Stations" }, "hub has more than 2000 chargers; results are incomplete");
  return list;
}

// If the hub fails, the last known locations are still used, but live status is marked unknown
async function getChargers() {
  if (cache.chargers && Date.now() - cache.at < TTL_MS) return { chargers: cache.chargers, live: true };
  try {
    inflight ||= fetchChargers().finally(() => { inflight = null; });
    cache = { chargers: await inflight, at: Date.now() };
    return { chargers: cache.chargers, live: true };
  } catch (e) {
    if (!cache.chargers) throw e;
    logger.error({ component: "Stations", err: e }, `using old station data: ${e.message}`);
    return { chargers: cache.chargers, live: false };
  }
}

function validCoords(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

// Haversine: straight-line distance in km (not road distance)
function distanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// The hub returns one row per charger: combine them into one entry per station
function toStations(chargers) {
  const map = new Map();
  for (const ch of chargers) {
    const id = ch.stationUid || ch.stationName;
    const lat = ch.latitude, lng = ch.longitude;
    if (!id || lat === null || lng === null || lat === "" || lng === "") continue;
    const p = { lat: Number(lat), lng: Number(lng) };
    if (!validCoords(p.lat, p.lng) || (p.lat === 0 && p.lng === 0)) continue;
    const s = map.get(id) || {
      id, name: ch.stationName, city: ch.city, state: ch.state,
      latitude: p.lat, longitude: p.lng,
      chargers: { total: 0, online: 0 },
      connectors: { total: 0, available: 0 },
    };
    s.chargers.total++;
    if (ch.online === true) s.chargers.online++;
    for (const con of ch.connectors || []) {
      s.connectors.total++;
      if (ch.online === true && con.status === "Available") s.connectors.available++;
    }
    map.set(id, s);
  }
  return Array.from(map.values());
}

export async function nearestStations(req, res) {
  const num = (v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
  const lat = num(req.query.lat);
  const lng = num(req.query.lng);
  if (!validCoords(lat, lng)) return res.status(400).json({ message: "Valid lat and lng are required" });

  const radius = Math.min(500, num(req.query.radius) > 0 ? num(req.query.radius) : 50); // km
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
  const onlineOnly = req.query.onlineOnly === "true";

  if (!cfg().token) return res.status(503).json({ message: "Station search is not configured on the server" });

  try {
    const { chargers, live } = await getChargers();

    let stations = toStations(chargers)
      .map((s) => ({ ...s, km: distanceKm({ lat, lng }, { lat: s.latitude, lng: s.longitude }) }))
      .filter((s) => s.km <= radius)
      .sort((a, b) => a.km - b.km)
      .map(({ km, ...s }) => ({
        ...s,
        distanceKm: Math.round(km * 100) / 100,
        isOnline: live ? s.chargers.online > 0 : null,
        chargers: live ? s.chargers : null,
        connectors: live ? s.connectors : null,
      }));

    // with old data we cannot know what is online, so do not filter
    if (onlineOnly && live) stations = stations.filter((s) => s.isOnline);

    return res.json({ stations: stations.slice(0, limit), liveStatusAvailable: live });
  } catch (e) {
    logger.error({ component: "Stations", err: e }, `nearest search failed: ${e.message}`);
    return res.status(e.name === "TimeoutError" ? 504 : 502).json({ message: "Could not find nearby stations" });
  }
}

const router = Router();
router.get("/nearest", authenticate, nearestStations);

export default router;