import mongoose from 'mongoose';

const ticketSchema = new mongoose.Schema(
  {
    ticketNumber: {
      type: String,
      unique: true,
      required: true
    },
    subject: {
      type: String,
      required: true,
      trim: true
    },
    description: {
      type: String,
      trim: true
    },
    customerName: {
      type: String,
      trim: true
    },
    customerPhone: {
      type: String,
      trim: true
    },
    customerEmail: {
      type: String,
      trim: true,
      lowercase: true
    },
    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      required: true
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'urgent'],
      default: 'medium'
    },
    status: {
      type: String,
      enum: ['open', 'assigned', 'in_progress', 'partially_resolved', 'waiting_for_parts', 'on_hold', 'resolved', 'closed', 'reopened'],
      default: 'open'
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    closedAt: {
      type: Date
    },
    faultDescription: {
      type: String,
      trim: true
    },
    resolutionType: {
      type: String,
      enum: ['fully_repaired', 'partially_repaired', 'part_missing', 'spare_part_required', 'fault_not_identified', 'additional_fault_found', 'repair_blocked', 'no_fault_found'],
      default: null
    },
    partsRequired: {
      type: {
        partName: { type: String, trim: true },
        quantity: { type: Number, min: 1 }
      },
      default: null
    },
    escalationHours: {
      type: Number,
      default: 24
    },
    escalatedAt: {
      type: Date,
      default: null
    },
    createdAt: {
      type: Date,
      default: Date.now
    },
    updatedAt: {
      type: Date,
      default: Date.now
    }
  },
  { timestamps: true }
);

// Recommended indexes
ticketSchema.index({ departmentId: 1, status: 1 });
ticketSchema.index({ assignedTo: 1, status: 1 });
ticketSchema.index({ createdBy: 1 });

const Ticket = mongoose.model('Ticket', ticketSchema);

export default Ticket;