// routes/monitoring.js  (ES module, maintenance backend)
// Lets logged-in maintenance users (service engineers etc.) see the charger health monitoring.
// The browser never gets the monitoring token: this server calls the OCPP hub with it.
//
// Login is checked inside this file (router.use(authenticate)), like your other route files.
// Mount it like the ticket routes, with no extra middleware:
//   import monitoringRoutes from "./routes/monitoring.js";
//   app.use("/api/monitoring", monitoringRoutes);
//
// ENV
//   TECH_TOKEN                 required: token of the dedicated monitoring account on the OCPP hub
//   HEALTH_API_BASE            default https://ocpphub.eeil.online/api/v1/technical/monitoring
//   MONITORING_ROLES           roles allowed to see monitoring (default admin,customer_support_manager,technical_manager,service_engineer)
//   MONITORING_CACHE_SECONDS   default 30 (many people opening the page = one call to the hub)
import { Router } from "express";
import { authenticate } from "../middlewares/auth.js";

const cfg = () => ({
  base: (process.env.HEALTH_API_BASE || "https://ocpphub.eeil.online/api/v1/technical/monitoring").replace(/\/+$/, ""),
  token: process.env.TECH_TOKEN || "",
  roles: String(process.env.MONITORING_ROLES || "admin,customer_support_manager,technical_manager,service_engineer").split(",").map((s) => s.trim()).filter(Boolean),
  ttlMs: (process.env.MONITORING_CACHE_SECONDS === undefined || process.env.MONITORING_CACHE_SECONDS === ""
    ? 30 : Number(process.env.MONITORING_CACHE_SECONDS) || 0) * 1000,
});

const OVERVIEW_QUERY = ["station_id", "stationId", "severity", "category", "online", "limit", "offset"];
const SUMMARY_QUERY = ["station_id", "stationId"];
const MAX_CACHE = 200;

const cache = new Map();    // url -> { at, body }
const inflight = new Map(); // url -> Promise (several requests for the same page share one call)

function allowed(user, roles) {
  const perms = user?.role?.permissions || [];
  return perms.includes("*") || perms.includes("monitoring:view") || roles.includes(user?.role?.name);
}

async function callHub(url, token) {
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(30000) });
  let body = null;
  try { body = await res.json(); } catch (e) { /* not JSON */ }
  return { status: res.status, body };
}

async function forward(req, res, path, allowedQuery) {
  const c = cfg();
  if (!c.token) return res.status(503).json({ message: "Monitoring is not configured on the server" });

  const qs = new URLSearchParams();
  allowedQuery.forEach((k) => { if (req.query[k] !== undefined && req.query[k] !== "") qs.set(k, String(req.query[k])); });
  qs.sort(); // same page = same cache key
  const url = c.base + path + (qs.toString() ? "?" + qs.toString() : "");

  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < c.ttlMs) return res.json(hit.body);

  try {
    if (!inflight.has(url)) inflight.set(url, callHub(url, c.token).finally(() => inflight.delete(url)));
    const { status, body } = await inflight.get(url);

    if (status === 200 && body) {
      if (c.ttlMs > 0) {
        if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
        cache.set(url, { at: Date.now(), body });
      }
      return res.json(body);
    }
    if (status === 400 || status === 404) return res.status(status).json({ message: (body && body.message) || "Request not accepted" });
    // 401/403/5xx from the hub: never pass 401 on, the browser would think the engineer's own login expired
    console.error(`[Monitoring] hub answered ${status} for ${path}${status === 401 || status === 403 ? " - check TECH_TOKEN" : ""}`);
    return res.status(502).json({ message: "Monitoring service is unavailable" });
  } catch (e) {
    console.error(`[Monitoring] hub call failed for ${path}: ${e.message}`);
    return res.status(e.name === "TimeoutError" ? 504 : 502).json({ message: "Monitoring service is unavailable" });
  }
}

const router = Router();

router.use(authenticate);

router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ message: "Not logged in" });
  if (!allowed(req.user, cfg().roles)) return res.status(403).json({ message: "You do not have access to monitoring" });
  next();
});

router.get("/overview", (req, res) => forward(req, res, "/overview", OVERVIEW_QUERY));
router.get("/summary", (req, res) => forward(req, res, "/summary", SUMMARY_QUERY));
router.get("/:ocppId", (req, res) => forward(req, res, "/" + encodeURIComponent(req.params.ocppId), []));

export default router;