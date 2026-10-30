// Health.js - charger health monitor with auto ticket creation
//
// Usage:
//   TECH_TOKEN=xxxx node Health.js            -> one check, prints summary
//   TECH_TOKEN=xxxx node Health.js alert      -> keep polling, alert + auto-create tickets
//
// Required env: TECH_TOKEN
// Optional env: HEALTH_API_BASE, ALERT_POLL_SECONDS, ALERT_WEBHOOK_URL, MONGODB_URI,
//               TICKET_ON_START (true = also create tickets for chargers already bad at startup)

const BASE = (process.env.HEALTH_API_BASE || 'https://ocpphub.eeil.online/api/v1/technical/monitoring').replace(/\/+$/, '');
const TOKEN = process.env.TECH_TOKEN || '';
const POLL_MS = (Number(process.env.ALERT_POLL_SECONDS) || 60) * 1000;
const WEBHOOK = process.env.ALERT_WEBHOOK_URL || '';
const TICKET_ON_START = String(process.env.TICKET_ON_START || 'false').toLowerCase() === 'true';

// Ticket statuses that count as "finished". Adjust to the values in your Ticket model.
const CLOSED_STATUSES = ['closed', 'resolved', 'cancelled', 'completed'];

// Ticket model references - initialized at runtime
let Ticket = null;
let User = null;
let warnedNoManager = false;

/**
 * Connect to MongoDB and load the project models.
 * If anything fails, ticket creation is disabled but alerts keep working.
 */
async function initModels() {
    try {
        const mongoose = require('mongoose');
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/maintainance');

        const ticketModel = require('./Models/Ticket.js');
        Ticket = ticketModel.default || ticketModel;

        const userModel = require('./Models/User.js');
        User = userModel.default || userModel;

        console.log('Models initialized successfully');
    } catch (e) {
        Ticket = null;
        User = null;
        console.error('Ticket creation disabled (alerts still run): ' + e.message);
    }
}

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function call(path) {
    const res = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + TOKEN } });
    let body = null;
    try { body = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok) {
        throw new Error(path + ' failed: ' + res.status + ' ' + ((body && body.message) || res.statusText));
    }
    return body.data;
}

async function check() {
    const s = await call('/summary');
    console.log('Generated at:', s.generatedAt);
    console.table(s.summary);
    console.log('\nCritical chargers (' + s.critical.length + '):');
    s.critical.forEach((c) => {
        console.log('- ' + c.chargerName + ' [' + c.ocppId + '] @ ' + c.stationName);
        c.issues.forEach((i) => console.log('    ' + i));
    });
    const off = await call('/overview?online=false&limit=2000');
    console.log('\nOffline chargers:', off.data.length);
    off.data.slice(0, 20).forEach((c) => console.log('- ' + c.chargerName + ' (' + c.stationName + ') ' + c.severity));
}

async function notify(text) {
    console.log('[ALERT] ' + text);
    if (!WEBHOOK) return;
    try {
        await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    } catch (e) { console.error('Webhook failed:', e.message); }
}

/**
 * Create a ticket for a critical/high charger, unless it already has an open one.
 * The charger is identified by the tag "[ocpp:<id>]" written into the ticket description.
 * Never throws: a ticket problem must not stop the alerts.
 */
async function createTicketForCharger(charger) {
    try {
        if (!Ticket || !User) {
            console.error('Ticket models not loaded - skipping ticket for ' + charger.chargerName);
            return null;
        }

        const tag = '[ocpp:' + charger.ocppId + ']';

        // Do not create a duplicate while an open ticket exists for this charger
        const existing = await Ticket.findOne({
            description: { $regex: escapeRegex(tag) },
            status: { $nin: CLOSED_STATUSES }
        });
        if (existing) {
            console.log('Open ticket #' + existing.ticketNumber + ' already exists for ' + charger.chargerName + ' - not creating another');
            return existing;
        }

        const supportManager = await User.findOne({ 'role.name': 'customer_support_manager' });
        if (!supportManager) {
            if (!warnedNoManager) {
                console.error('Customer support manager not found - cannot create tickets');
                warnedNoManager = true;
            }
            return null;
        }

        const severity = charger.severity;
        const priority = ({ critical: 'urgent', high: 'high', medium: 'medium', low: 'low' })[severity] || 'medium';
        const issuesText = (charger.issues || []).join('; ') || 'No specific issues reported';

        const ticket = await Ticket.create({
            // Date.now() + random suffix: no repeats between tickets created close together
            ticketNumber: 'AUTO-' + Date.now() + '-' + String(Math.floor(Math.random() * 1000)).padStart(3, '0'),
            subject: 'Charger issue: ' + charger.chargerName + ' [' + severity.toUpperCase() + ']',
            description: 'Charger ' + charger.chargerName + ' (' + charger.stationName + ') has ' +
                severity.toUpperCase() + ' severity: ' + issuesText + ' ' + tag,
            customerName: 'Auto-detected',
            customerPhone: '',
            customerEmail: '',
            departmentId: supportManager.departmentId || null,
            priority,
            status: 'open',
            createdBy: supportManager._id,
            assignedTo: supportManager._id,
            assignedBy: supportManager._id,
            faultDescription: issuesText,
            escalationHours: 24,
            resolutionType: null
        });

        console.log('Auto-created ticket #' + ticket.ticketNumber + ' for ' + charger.chargerName + ' (' + priority + ')');
        return ticket;
    } catch (err) {
        console.error('Failed to create ticket for ' + charger.chargerName + ':', err.message);
        return null;
    }
}

function alertLoop() {
    const BAD = ['critical', 'high'];
    let previous = null;
    async function poll() {
        try {
            const o = await call('/overview?limit=2000');
            const current = new Map(o.data.map((c) => [c.ocppId, c]));
            if (!previous) {
                console.log('Baseline: ' + o.data.length + ' chargers. Watching for changes...');
                if (TICKET_ON_START) {
                    for (const c of current.values()) {
                        if (BAD.includes(c.severity)) await createTicketForCharger(c);
                    }
                }
            } else {
                for (const [id, c] of current) {
                    const was = previous.get(id);
                    const nowBad = BAD.includes(c.severity);
                    const wasBad = was && BAD.includes(was.severity);
                    if (nowBad && !wasBad) {
                        await createTicketForCharger(c);
                        await notify(c.chargerName + ' (' + c.stationName + ') is ' + c.severity.toUpperCase() + ': ' + (c.issues || []).join('; '));
                    } else if (!nowBad && wasBad) {
                        await notify(c.chargerName + ' (' + c.stationName + ') recovered (now ' + c.severity + ')');
                    }
                }
            }
            previous = current;
        } catch (e) { console.error('Poll failed:', e.message); }
    }
    poll();
    setInterval(poll, POLL_MS);
}

if (!TOKEN) {
    console.error('TECH_TOKEN is required. Set it as an environment variable (do not put it in the code).');
    process.exit(1);
}

if (process.argv[2] === 'alert') {
    initModels().then(alertLoop);
} else {
    check().catch((e) => { console.error(e.message); process.exit(1); });
}