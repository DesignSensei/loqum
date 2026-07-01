// models/Credit.js

const mongoose = require("mongoose");

/**
 * CREDIT MODEL:
 *
 * Stores a professional's Credits balance.
 *
 * Credits are dormant at launch.
 * Professionals apply for shifts for free in the MVP.
 *
 * This model exists so Loqum can later introduce Credits for:
 * - paid applications
 * - boosted applications
 * - priority visibility
 * - promotional credits
 *
 * IMPORTANT:
 * Credits are not Naira wallet funds.
 * Credits are platform units.
 *
 * Wallet handles money.
 * Credit handles future professional-side platform credits.
 * CreditTransaction records every credit movement.
 *
 * Credits should only become active when creditsEnabled is true in PlatformSettings.
 */

const creditSchema = new mongoose.Schema(
  {
    // --- OWNERSHIP ---

    professional: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProfessionalProfile",
      required: true,
    },

    // --- BALANCES ---

    availableCredits: {
      type: Number,
      default: 0,
      min: 0,
      // Credits available for use.
    },

    pendingCredits: {
      type: Number,
      default: 0,
      min: 0,
      // Credits being processed, held, or awaiting confirmation.
      // Useful for future purchases or admin review.
    },

    lifetimeCreditsEarned: {
      type: Number,
      default: 0,
      min: 0,
      // Total Credits ever credited to this professional.
    },

    lifetimeCreditsUsed: {
      type: Number,
      default: 0,
      min: 0,
      // Total Credits ever debited from this professional.
    },

    lifetimeCreditsRefunded: {
      type: Number,
      default: 0,
      min: 0,
      // Total Credits ever refunded to this professional.
    },

    // --- STATUS ---

    status: {
      type: String,
      enum: ["active", "frozen", "closed"],
      default: "active",
      // active: Credits can move when enabled.
      // frozen: no Credit movement allowed pending review.
      // closed: Credit account closed. Balances must be zero.
    },

    frozenReason: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },

    frozenAt: {
      type: Date,
      default: null,
    },

    closedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// --- INDEXES ---

creditSchema.index({ professional: 1 }, { unique: true });
creditSchema.index({ status: 1 });

// --- VALIDATION / AUTO-CLEANUP ---

creditSchema.pre("validate", function () {
  if (this.status === "frozen" && !this.frozenAt) {
    this.frozenAt = new Date();
  }

  if (this.status !== "frozen") {
    this.frozenReason = null;
    this.frozenAt = null;
  }

  if (this.status === "closed") {
    const hasCredits = this.availableCredits > 0 || this.pendingCredits > 0;

    if (hasCredits) {
      throw new Error("Credit balance must be zero before closing.");
    }

    if (!this.closedAt) {
      this.closedAt = new Date();
    }
  }

  if (this.status !== "closed") {
    this.closedAt = null;
  }
});

module.exports = mongoose.model("Credit", creditSchema);
