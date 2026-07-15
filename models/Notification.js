// models/Notification.js

const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    recipientUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    employer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
      default: null,
      index: true,
    },

    professional: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProfessionalProfile",
      default: null,
      index: true,
    },

    category: {
      type: String,
      required: true,
      enum: ["finance", "shift", "team", "account", "system"],
      index: true,
    },

    type: {
      type: String,
      required: true,
      enum: [
        // Finance
        "wallet_funded",
        "withdrawal_submitted",
        "withdrawal_completed",
        "withdrawal_reversed",

        // Shift
        "shift_created",
        "shift_approved",
        "shift_cancelled",
        "shift_filled",
        "payment_required",

        // Team
        "team_invite_received",
        "team_invite_accepted",
        "team_member_removed",
        "team_role_changed",

        // Account
        "account_updated",
        "security_alert",

        // System
        "system_message",
      ],
      index: true,
    },

    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },

    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },

    actionUrl: {
      type: String,
      trim: true,
      default: null,
    },

    status: {
      type: String,
      enum: ["unread", "read", "archived"],
      default: "unread",
      index: true,
    },

    readAt: {
      type: Date,
      default: null,
    },

    relatedWallet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      default: null,
    },

    relatedTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },

    relatedShift: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shift",
      default: null,
    },

    relatedInvite: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invite",
      default: null,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

notificationSchema.index({
  recipientUser: 1,
  status: 1,
  createdAt: -1,
});

notificationSchema.index({
  recipientUser: 1,
  category: 1,
  createdAt: -1,
});

notificationSchema.index({
  employer: 1,
  category: 1,
  createdAt: -1,
});

notificationSchema.index({
  professional: 1,
  category: 1,
  createdAt: -1,
});

notificationSchema.pre("validate", function validateNotificationOwnership() {
  const hasEmployer = Boolean(this.employer);
  const hasProfessional = Boolean(this.professional);

  if (hasEmployer && hasProfessional) {
    this.invalidate(
      "professional",
      "A notification cannot belong to both an employer and a professional."
    );
  }
});

module.exports = mongoose.model("Notification", notificationSchema);
