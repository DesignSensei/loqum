// models/Notification.js

const mongoose = require("mongoose");

const {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPES_BY_CATEGORY,
} = require("../constants/notification");

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
      enum: NOTIFICATION_CATEGORIES,
      index: true,
    },

    type: {
      type: String,
      required: true,
      enum: NOTIFICATION_TYPES,
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
      enum: NOTIFICATION_STATUSES,
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

    relatedOccurrence: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftOccurrence",
      default: null,
    },

    relatedClaim: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftOccurrenceClaim",
      default: null,
    },

    relatedDispute: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ShiftOccurrenceDispute",
      default: null,
    },

    relatedEmployerRefund: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerRefund",
      default: null,
    },

    relatedInvite: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invite",
      default: null,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
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

notificationSchema.index({
  relatedShift: 1,
  createdAt: -1,
});

notificationSchema.index({
  relatedOccurrence: 1,
  createdAt: -1,
});

notificationSchema.index({
  relatedClaim: 1,
  createdAt: -1,
});

notificationSchema.index({
  relatedDispute: 1,
  createdAt: -1,
});

notificationSchema.index({
  relatedEmployerRefund: 1,
  createdAt: -1,
});

notificationSchema.pre("validate", function validateNotificationContract() {
  const hasEmployer = Boolean(this.employer);
  const hasProfessional = Boolean(this.professional);

  if (hasEmployer && hasProfessional) {
    this.invalidate(
      "professional",
      "A notification cannot belong to both an employer and a professional."
    );
  }

  const allowedTypes = NOTIFICATION_TYPES_BY_CATEGORY[this.category];

  if (
    this.category &&
    this.type &&
    (!Array.isArray(allowedTypes) || !allowedTypes.includes(this.type))
  ) {
    this.invalidate(
      "type",
      `Notification type ${this.type} does not belong to category ${this.category}.`
    );
  }

  if (this.status === "unread" && this.readAt) {
    this.invalidate("readAt", "An unread notification cannot have a read timestamp.");
  }

  if (this.status === "read" && !this.readAt) {
    this.invalidate("readAt", "A read notification requires a read timestamp.");
  }
});

module.exports = mongoose.model("Notification", notificationSchema);
