import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../DB/DB.js";
import Ticket from "../Models/Ticket.js";

/**
 * One-time backfill: tag existing tickets as 'auto' or 'normal'.
 *
 * A ticket is considered 'auto' if its ticketNumber starts with 'AUTO-' (the
 * prefix used by the health monitor) or its description carries an
 * '[ocpp:<id>]' charger tag. Every other ticket is 'normal'.
 *
 * Run once after deploying the ticketType field:
 *   node scripts/backfillTicketType.js
 */
async function backfill() {
  await connectDB();

  const autoQuery = {
    $or: [
      { ticketNumber: { $regex: /^AUTO-/ } },
      { description: { $regex: /\[ocpp:/ } },
    ],
  };

  const autoTickets = await Ticket.updateMany(
    { ...autoQuery, ticketType: { $ne: "auto" } },
    { $set: { ticketType: "auto" } }
  );

  const normalTickets = await Ticket.updateMany(
    { ticketType: { $exists: false } },
    { $set: { ticketType: "normal" } }
  );

  const totals = await Ticket.aggregate([
    { $group: { _id: { $ifNull: ["$ticketType", "normal"] }, count: { $sum: 1 } } },
  ]);

  console.log("Backfill complete:");
  console.log(" - auto tickets tagged:", autoTickets.modifiedCount);
  console.log(" - missing ticketType set to 'normal':", normalTickets.modifiedCount);
  console.log(" - current totals:", totals);

  await mongoose.disconnect();
}

backfill().catch((err) => {
  console.error("Backfill failed:", err);
  process.exitCode = 1;
});
