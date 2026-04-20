// models/User.js

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    /* ---------- Basic Information ---------- */
    firstName: {
      type: String,
      required: true,
      trim: true,
    },

    lastName: {
      type: String,
      required: true,
      trim: true,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    password: {
      type: String,
      required: true,
      select: false,
    },

    /* ---------- OAuth Configuration ---------- */
    googleId: {
      type: String,
      index: true,
      unique: true,
      sparse: true,
    },

    /* ---------- Access Control ---------- */
    role: {
      type: String,
      enum: ["admin", "pharmacist", "employer"],
      required: true,
    },

    pharmacistProfile: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PharmacistProfile",
    },

    employerProfile: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployerProfile",
    },

    /* ---------- Security & Verification Status ---------- */
    isVerified: {
      type: Boolean,
      default: false,
    },

    twoFactorEnabled: {
      type: Boolean,
      default: false,
    },

    /* ---------- Onboarding Status ---------- */
    // Crucial for the isNotOnboarded/isOnboarded middleware logic
    isOnboarded: {
      type: Boolean,
      default: false,
    },

    /* ---------- OTP / Two-Factor Logic ---------- */
    otp: {
      type: String,
      select: false,
    },

    otpExpiry: {
      type: Date,
      select: false,
    },

    otpAttempts: {
      type: Number,
      default: 0,
    },

    otpLastSentAt: {
      type: Date,
    },

    /* ---------- Password Recovery ---------- */
    resetPasswordToken: {
      type: String,
      select: false,
    },

    resetPasswordExpiry: {
      type: Date,
      select: false,
    },
  },
  {
    timestamps: true,
  },
);

/* ---------- Pre-save Middleware (Password Hashing) ---------- */
// This runs automatically before the document is saved to MongoDB.
userSchema.pre("save", async function () {
  // Only hash the password if it has been modified (or is new)
  if (!this.isModified("password")) return;

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
  } catch (error) {
    throw error;
  }
});

/* ---------- Instance Method (Password Verification) ---------- */
// Allows you to check if a login password matches the hashed version in the DB.
userSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model("User", userSchema);
