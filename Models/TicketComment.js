import mongoose from 'mongoose';

const ticketCommentSchema = new mongoose.Schema(
  {
    ticketId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Ticket',
      required: true,
      index: true
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    comment: {
      type: String,
      required: true,
      trim: true
    },
    isInternalNote: {
      type: Boolean,
      default: false
    },
    createdAt: {
      type: Date,
      default: Date.now,
      index: true
    }
  },
  { timestamps: true }
);

ticketCommentSchema.index({ ticketId: 1, createdAt: 1 });

const TicketComment = mongoose.model('TicketComment', ticketCommentSchema);

export default TicketComment;