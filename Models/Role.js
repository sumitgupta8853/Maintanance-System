
import mongoose from 'mongoose';

const roleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    description: {
      type: String,
      trim: true,
    },

    // Example: ["role:manage", "report:read"] or ["*"] for full access
    permissions: {
      type: [String],
      default: [],
    },

    // System roles cannot be deleted
    isSystem: {
      type: Boolean,
      default: false,
    },

    // Optional department scoping
    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      default: null,
    },
  },
  { timestamps: true }
);

const Role = mongoose.model('Role', roleSchema);

export default Role;
