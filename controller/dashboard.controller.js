import Ticket from '../Models/Ticket.js';
import User from '../Models/User.js';
import Department from '../Models/Department.js';
import AuditLog from '../Models/AuditLog.js';

// Every status defined on the Ticket model
const ALL_STATUSES = [
  'open',
  'assigned',
  'in_progress',
  'partially_resolved',
  'waiting_for_parts',
  'on_hold',
  'resolved',
  'closed',
  'reopened'
];

const OPEN_STATUSES = new Set([
  'open',
  'assigned',
  'in_progress',
  'partially_resolved',
  'waiting_for_parts',
  'on_hold',
  'reopened'
]);

const CLOSED_STATUSES = new Set(['resolved', 'closed']);

const emptyStatusCounts = () =>
  Object.fromEntries(ALL_STATUSES.map((s) => [s, 0]));

/**
 * GET /api/dashboard
 * Composite dashboard: all-status counts + recent tickets + charger health
 */
export const getDashboard = async (req, res, next) => {
  try {
    const [total, statusRows, urgent, recent] = await Promise.all([
      Ticket.countDocuments({}),
      Ticket.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      Ticket.countDocuments({ priority: 'urgent', status: { $nin: ['resolved', 'closed'] } }),
      Ticket.find()
        .sort({ createdAt: -1 })
        .limit(10)
        .populate('departmentId', 'name')
        .populate('assignedTo', 'name email')
        .lean()
    ]);

    const statusCounts = emptyStatusCounts();
    statusRows.forEach((r) => {
      if (r._id) statusCounts[r._id] = r.count;
    });

    return res.json({
      totalTickets: total,
      statusCounts,
      urgentTickets: urgent,
      recentTickets: recent
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/dashboard/summary
 * KPI cards: counts of every ticket status + users + departments
 */
export const getSummary = async (req, res, next) => {
  try {
    const [total, statusRows, priorityRows, users, departments, urgent] =
      await Promise.all([
        Ticket.countDocuments({}),
        Ticket.aggregate([
          { $group: { _id: '$status', count: { $sum: 1 } } }
        ]),
        Ticket.aggregate([
          { $group: { _id: '$priority', count: { $sum: 1 } } }
        ]),
        User.countDocuments({ isActive: true }),
        Department.countDocuments({}),
        Ticket.countDocuments({ priority: 'urgent', status: { $nin: ['resolved', 'closed'] } })
      ]);

    const statusCounts = emptyStatusCounts();
    statusRows.forEach((r) => {
      if (r._id) statusCounts[r._id] = r.count;
    });

    const openTickets = Object.entries(statusCounts)
      .filter(([status]) => OPEN_STATUSES.has(status))
      .reduce((sum, [, count]) => sum + count, 0);

    const closedTickets =
      (statusCounts.resolved || 0) + (statusCounts.closed || 0);

    return res.json({
      totalTickets: total,
      openTickets,
      assignedTickets: statusCounts.assigned || 0,
      inProgressTickets: statusCounts.in_progress || 0,
      resolvedTickets: statusCounts.resolved || 0,
      closedTickets,
      urgentTickets: urgent,
      statusCounts,
      activeUsers: users,
      totalDepartments: departments
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/dashboard/tickets/stats
 * Ticket count grouped by status (one row per status)
 */
export const getTicketStats = async (req, res, next) => {
  try {
    const rows = await Ticket.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);
    const stats = emptyStatusCounts();
    rows.forEach((r) => {
      if (r._id) stats[r._id] = r.count;
    });
    return res.json(stats);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/dashboard/tickets/priority
 * Ticket count grouped by priority
 */
export const getTicketPriority = async (req, res, next) => {
  try {
    const rows = await Ticket.aggregate([
      { $group: { _id: '$priority', count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);
    return res.json(
      Object.fromEntries(rows.map((r) => [r._id || 'unknown', r.count]))
    );
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/dashboard/tickets/department
 * Ticket count grouped by department
 */
export const getTicketDepartment = async (req, res, next) => {
  try {
    const rows = await Ticket.aggregate([
      {
        $group: {
          _id: '$departmentId',
          count: { $sum: 1 }
        }
      },
      {
        $lookup: {
          from: 'departments',
          localField: '_id',
          foreignField: '_id',
          as: 'department'
        }
      },
      { $unwind: { path: '$department', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          departmentId: '$_id',
          department: { $ifNull: ['$department.name', 'Unassigned'] },
          count: 1
        }
      },
      { $sort: { count: -1 } }
    ]);
    return res.json(rows);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/dashboard/tickets/trend
 * Daily ticket creation trend (last 30 days)
 */
export const getTicketTrend = async (req, res, next) => {
  try {
    const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rows = await Ticket.aggregate([
      { $match: { createdAt: { $gte: from } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    return res.json(rows);
  } catch (err) {
    next(err);
  }
};


/**
 * GET /api/dashboard/recent
 * Most recent tickets with department & assignee names
 */
export const getRecentTickets = async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const tickets = await Ticket.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('departmentId', 'name')
      .populate('assignedTo', 'name email')
      .populate('createdBy', 'name email')
      .lean();
    return res.json(tickets);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/dashboard/charger-health
 * Charger health summary from the external OCPP monitoring API
 * (same forwarding pattern as /api/monitoring)
 */
export const getChargerHealth = async (req, res, next) => {
  try {
    const token = process.env.TECH_TOKEN;
    const base = (
      process.env.HEALTH_API_BASE ||
      'https://ocpphub.eeil.online/api/v1/technical/monitoring'
    ).replace(/\/+$/, '');

    if (!token) {
      return res
        .status(503)
        .json({ message: 'Monitoring is not configured on the server' });
    }

    const url = base + '/overview?limit=2000';
    const hubRes = await fetch(url, {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(30000)
    });

    let body = null;
    try {
      body = await hubRes.json();
    } catch (e) {
      /* not JSON */
    }

    if (!hubRes.ok) {
      return res.status(hubRes.status).json({
        message: (body && body.message) || 'Monitoring service is unavailable'
      });
    }

    return res.json(body);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/dashboard/engineers
 * Tickets per assigned engineer (open / closed counts)
 */
export const getEngineers = async (req, res, next) => {
  try {
    const rows = await Ticket.aggregate([
      { $match: { assignedTo: { $ne: null } } },
      {
        $group: {
          _id: '$assignedTo',
          total: { $sum: 1 },
          open: {
            $sum: {
              $cond: [{ $in: ['$status', [...OPEN_STATUSES]] }, 1, 0]
            }
          },
          closed: {
            $sum: {
              $cond: [{ $in: ['$status', [...CLOSED_STATUSES]] }, 1, 0]
            }
          }
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          engineerId: '$_id',
          name: { $ifNull: ['$user.name', 'Unassigned'] },
          email: '$user.email',
          total: 1,
          open: 1,
          closed: 1
        }
      },
      { $sort: { total: -1 } },
      { $limit: 50 }
    ]);
    return res.json(rows);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/dashboard/activity
 * Recent audit-log activity
 */
export const getActivity = async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const activity = await AuditLog.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('actor', 'name email')
      .lean();
    return res.json(activity);
  } catch (err) {
    next(err);
  }
};

