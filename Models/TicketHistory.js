import mongoose from 'mongoose';

const ticketHistorySchema = new mongoose.Schema(
  {
    ticketId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Ticket',
      required: true,
      index: true
    },
    type: {
      type: String,
      enum: ['status', 'field'],
      required: true
    },
    field: {
      type: String,
      required: true,
      trim: true
    },
    oldValue: {
      type: mongoose.Schema.Types.Mixed
    },
    newValue: {
      type: mongoose.Schema.Types.Mixed
    },
    note: {
      type: String,
      trim: true
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    createdAt: {
      type: Date,
      default: Date.now,
      index: true
    }
  },
  { timestamps: true }
);

ticketHistorySchema.index({ ticketId: 1, createdAt: -1 });

const TicketHistory = mongoose.model('TicketHistory', ticketHistorySchema);

export default TicketHistory;