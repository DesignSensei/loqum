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

    displayName: {
      type: String,
      trim: true,
      default: "",
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
      required: function () {
        return this.authProvider === "local";
      },
      select: false,
    },

    /* ---------- Auth Provider ---------- */
    authProvider: {
      type: String,
      enum: ["local", "google"],
      default: "local",
    },

    /* ---------- OAuth Configuration ---------- */
    googleId: {
      type: String,
      index: true,
      unique: true,
      sparse: true,
    },

    photo: {
      type: String,
      default: "",
    },

    /* ---------- Access Control ---------- */
    role: {
      type: String,
      enum: ["admin", "professional", "employer"],
      required: true,
    },

    professionalProfile: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProfessionalProfile",
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

    accountStatus: {
      type: String,
      enum: ["active", "restricted", "suspended", "deactivated", "banned"],
      default: "active",
    },

    /* ---------- Onboarding Status ---------- */
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
  }
);

/* ---------- Pre-save Middleware (Password Hashing) ---------- */
userSchema.pre("save", async function () {
  if (!this.isModified("password") || !this.password) return;

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
  } catch (error) {
    throw error;
  }
});

/* ---------- Instance Method (Password Verification) ---------- */
userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.password) return false;

  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model("User", userSchema);
