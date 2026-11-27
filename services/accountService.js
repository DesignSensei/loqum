// services/accountService.js

const crypto = require("crypto");
const mongoose = require("mongoose");

const User = require("../models/User");
const EmployerProfile = require("../models/EmployerProfile");
const EmployerMember = require("../models/EmployerMember");
const ProfessionalProfile = require("../models/ProfessionalProfile");
const ShiftApplication = require("../models/ShiftApplication");
const JobApplication = require("../models/JobApplication");
const Appointment = require("../models/Appointment");
const ShiftAssignment = require("../models/ShiftAssignment");
const ShiftOccurrence = require("../models/ShiftOccurrence");
const ShiftAssignmentCase = require("../models/ShiftAssignmentCase");
const ShiftOccurrenceClaim = require("../models/ShiftOccurrenceClaim");
const ShiftOccurrenceDispute = require("../models/ShiftOccurrenceDispute");
const ShiftSettlementBatch = require("../models/ShiftSettlementBatch");
const ProviderEvent = require("../models/ProviderEvent");
const Wallet = require("../models/Wallet");
const Transaction = require("../models/Transaction");
const FinancialObligationService = require("./financialObligationService");
const AuthService = require("./authService");
const EmailService = require("./emailService");

const WalletService = require("./walletService");
const { createServiceError } = require("./helpers/serviceErrorHelper");
const { TERMINAL_APPLICATION_STATUSES } = require("../constants/shiftApplication");
const { TERMINAL_JOB_APPLICATION_STATUSES } = require("../constants/jobApplication");

async function readClosureQueries(session, queries) {
  if (!session) return Promise.all(queries);
  const results = [];
  for (const query of queries) results.push(await query.session(session));
  return results;
}

class AccountService {
  static normalizeEmail(email) {
    return String(email || "")
      .toLowerCase()
      .trim();
  }

  static isValidEmail(email) {
    const value = this.normalizeEmail(email);

    return (
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) &&
      !value.endsWith("@closed.loqum.invalid")
    );
  }

  static isValidUrl(value) {
    if (!value) return true;

    try {
      const url = new URL(value);

      return ["http:", "https:"].includes(url.protocol);
    } catch (error) {
      return false;
    }
  }

  static isValidProfilePhotoPath(photo) {
    if (!photo) return false;

    if (photo.startsWith("/uploads/users/")) {
      return true;
    }

    try {
      const url = new URL(photo);

      return ["http:", "https:"].includes(url.protocol);
    } catch (error) {
      return false;
    }
  }

  static isStrongPassword(password) {
    const value = String(password || "");

    return value.length >= 8 && /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value);
  }

  static formatMemberSince(date) {
    if (!date) return "-";

    return new Date(date).toLocaleDateString("en-NG", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  static getAccountTypeLabel(role) {
    const accountTypeLabels = {
      admin: "Admin",
      employer: "Employer",
      professional: "Professional",
    };

    return accountTypeLabels[role] || "User";
  }

  static getTeamRoleLabel({ user, employerMember, employerContext } = {}) {
    if (user?.role !== "employer") {
      return "None";
    }

    if (employerContext?.isPrimaryEmployer) {
      return "Owner";
    }

    const role = employerContext?.employerMemberRole || employerMember?.role;

    const teamRoleLabels = {
      owner: "Owner",
      admin: "Admin",
      employer_admin: "Admin",
      branch_manager: "Branch Manager",
      branch_staff: "Branch Staff",
      team_member: "Team Member",
    };

    return teamRoleLabels[role] || "Not assigned";
  }

  static buildSettingsView(user, options = {}) {
    const employerMember = options.employerMember || null;
    const employerContext = options.employerContext || null;

    const fullName = `${user?.firstName || ""} ${user?.lastName || ""}`.trim();

    return {
      profileView: {
        firstName: user?.firstName || "",
        lastName: user?.lastName || "",
        displayName: user?.displayName || fullName || user?.email || "User",
        email: user?.email || "",
        photo: user?.photo || "",

        phoneCode: user?.phoneCode || "+234",
        phoneNumber: user?.phoneNumber || "",

        legalNameIsProtected:
          !user || user.role === "professional" || user.legalNameSource === "nin_registry",

        accountTypeLabel: this.getAccountTypeLabel(user?.role),
        teamRoleLabel: this.getTeamRoleLabel({
          user,
          employerMember,
          employerContext,
        }),
        memberSinceLabel: this.formatMemberSince(user?.createdAt),

        twoFactorEnabled: Boolean(user?.twoFactorEnabled),
        twoFactorStatusLabel: user?.twoFactorEnabled ? "Enabled" : "Disabled",
        twoFactorStatusClass: user?.twoFactorEnabled
          ? "badge-light-success"
          : "badge-light-secondary",

        updateProfileUrl: "/account/settings/profile/update",
        updatePhotoUrl: "/account/settings/profile/photo",
      },

      securityView: {
        email: user?.email || "",
        authProvider: user?.authProvider || "local",

        hasPasswordLogin: user?.authProvider === "local",
        hasGoogleLogin: user?.authProvider === "google",

        passwordTitle: "Password Management",
        passwordStatusLabel: user?.authProvider === "google" ? "Managed by Google" : "Enabled",
        passwordStatusClass:
          user?.authProvider === "google" ? "badge-light-info" : "badge-light-success",
        passwordDescription:
          user?.authProvider === "google"
            ? "Your account uses Google authentication. Password changes should be made through your Google account."
            : "Update the password used to sign in to your Loqum account.",

        googleLoginStatus: user?.authProvider === "google" ? "Connected" : "Not connected",

        twoFactorEnabled: Boolean(user?.twoFactorEnabled),

        sendEnableTwoFactorOtpUrl: "/account/settings/2fa/send-enable-otp",
        enableTwoFactorUrl: "/account/settings/2fa/enable",

        sendDisableTwoFactorOtpUrl: "/account/settings/2fa/send-disable-otp",
        disableTwoFactorUrl: "/account/settings/2fa/disable",

        changePasswordUrl: "/account/settings/password/update",

        sendChangeEmailOtpUrl: "/account/settings/email/send-change-otp",
        confirmEmailChangeUrl: "/account/settings/email/confirm",
      },

      preferencesView: {
        notificationsStatusText:
          "Choose how you receive account, shift, wallet, and team updates. Notification controls will be available soon.",
        themeStatusText: "Choose how Loqum appears on this device.",
      },

      sessionsView: {
        currentSessionLabel: "Current session",
        currentSessionStatusLabel: "Active",
        currentSessionDescription: "You are currently signed in on this device.",
        activeDevicesStatusText:
          "Active device management will be available after session tracking is added.",
        showManageDevicesButton: false,
      },
    };
  }

  /* ---------- ACCOUNT CLOSURE ELIGIBILITY ---------- */
  static async getAccountClosureEligibility({ userId, session = null } = {}) {
    if (!mongoose.isValidObjectId(userId)) {
      throw new Error("A valid user is required.");
    }

    const user = await User.findById(userId)
      .select("_id role accountStatus isVerified isOnboarded professionalProfile")
      .session(session)
      .lean();

    if (!user) {
      throw new Error("User not found.");
    }

    const blockers = [];
    const pendingChecks = [];

    const addBlocker = (code, message) => blockers.push({ code, message });

    let professionalProfileId = null;
    let ownedBusinessCount = 0;
    let currentMembership = null;
    let walletCount = 0;

    if (!["professional", "employer", "admin"].includes(user.role)) {
      addBlocker("ACCOUNT_CLOSURE_ROLE_UNSUPPORTED", "This account type requires manual review.");
    }

    if (user.accountStatus !== "active" || user.isVerified !== true) {
      addBlocker(
        "ACCOUNT_CLOSURE_ACCOUNT_INELIGIBLE",
        "This account cannot use the standard closure process in its current status."
      );
    }

    if (user.role === "professional") {
      const profile = await ProfessionalProfile.findOne({ user: user._id })
        .select("_id accountStatus")
        .session(session).lean();

      if (profile) {
        professionalProfileId = String(profile._id);

        if (
          user.professionalProfile &&
          String(user.professionalProfile) !== professionalProfileId
        ) {
          addBlocker(
            "ACCOUNT_CLOSURE_PROFESSIONAL_PROFILE_MISMATCH",
            "Your professional profile linkage requires reconciliation before closure."
          );
        }

        if (profile.accountStatus !== "active") {
          addBlocker(
            "ACCOUNT_CLOSURE_PROFESSIONAL_REVIEW",
            "Resolve the professional account restriction or review before closure."
          );
        }

        const [openShiftApplication, activeJobApplication, scheduledAppointment] =
          await readClosureQueries(session, [
            ShiftApplication.exists({
              professional: profile._id,
              status: { $nin: TERMINAL_APPLICATION_STATUSES },
            }),
            JobApplication.exists({
              professional: profile._id,
              status: { $nin: TERMINAL_JOB_APPLICATION_STATUSES },
            }),
            Appointment.exists({ professional: profile._id, status: "scheduled" }),
          ]);

        if (openShiftApplication) {
          addBlocker("ACCOUNT_CLOSURE_OPEN_SHIFT_APPLICATIONS",
            "Resolve outstanding shift applications before account closure.");
        }
        if (activeJobApplication) {
          addBlocker("ACCOUNT_CLOSURE_OPEN_JOB_APPLICATIONS",
            "Resolve outstanding permanent job applications before account closure.");
        }
        if (scheduledAppointment) {
          addBlocker("ACCOUNT_CLOSURE_OPEN_JOB_APPOINTMENTS",
            "Resolve outstanding scheduled interviews before account closure.");
        }

        const now = new Date();
        const [
          ongoingAssignment,
          openAssignmentCase,
          activeClaim,
          activeDispute,
          unresolvedOccurrence,
          wallets,
        ] = await readClosureQueries(session, [
          ShiftAssignment.exists({
            professional: profile._id,
            status: { $in: ["scheduled", "active", "ending"] },
          }),
          ShiftAssignmentCase.exists({ professional: profile._id, isOpen: true }),
          ShiftOccurrenceClaim.exists({ professional: profile._id, status: "active" }),
          ShiftOccurrenceDispute.exists({ professional: profile._id, status: "active" }),
          ShiftOccurrence.exists({
            assignedProfessional: profile._id,
            $or: [
              { status: { $nin: ["completed", "cancelled", "no_show", "expired_unfilled"] } },
              { activeClaim: { $ne: null } },
              { activeDispute: { $ne: null } },
              {
                challengeDeadlineAt: { $gt: now },
                challengeWindowClosedAt: null,
              },
              {
                baseProfessionalPay: { $gt: 0 },
                "baseSettlement.status": { $ne: "released" },
              },
              {
                overtimeProfessionalPay: { $gt: 0 },
                "overtimeSettlement.status": { $ne: "released" },
              },
              { "overtime.status": { $in: ["pending", "disputed"] } },
            ],
          }),
          Wallet.find({ ownerType: "professional", professional: profile._id })
            .select("_id status availableBalance pendingBalance outstandingBalance")
            .lean(),
        ]);

        if (ongoingAssignment) {
          addBlocker(
            "ACCOUNT_CLOSURE_ACTIVE_ASSIGNMENTS",
            "Resolve scheduled, active or ending shift assignments before closure."
          );
        }

        if (openAssignmentCase) {
          addBlocker(
            "ACCOUNT_CLOSURE_OPEN_ASSIGNMENT_CASE",
            "An assignment exit or employer issue case is still open."
          );
        }

        if (activeClaim || activeDispute) {
          addBlocker(
            "ACCOUNT_CLOSURE_OPEN_FINANCIAL_CASE",
            "Resolve outstanding professional claims or employer disputes before closure."
          );
        }

        if (unresolvedOccurrence) {
          addBlocker(
            "ACCOUNT_CLOSURE_UNRESOLVED_OCCURRENCES",
            "An assigned occurrence still has work, challenge or payout obligations."
          );
        }

        const unresolvedSettlementBatch = await ShiftSettlementBatch.exists({
          professional: profile._id,
          status: {
            $nin: ["released", "cancelled"],
          },
        }).session(session);

        if (unresolvedSettlementBatch) {
          addBlocker(
            "ACCOUNT_CLOSURE_UNRESOLVED_SETTLEMENT_BATCH",
            "Resolve all scheduled, processing or failed professional settlement batches before closure."
          );
        }

        if (
          await FinancialObligationService.hasOutstandingObligations({
            professionalProfileId: profile._id,
          }, { session })
        ) {
          addBlocker(
            "ACCOUNT_CLOSURE_OUTSTANDING_FINANCIAL_OBLIGATIONS",
            "Resolve outstanding financial obligations before closing this account."
          );
        }

        walletCount = wallets.length;

        const providerEventScopes = [
          {
            professional: profile._id,
          },
        ];

        if (wallets.length > 0) {
          providerEventScopes.push({
            wallet: {
              $in: wallets.map((wallet) => wallet._id),
            },
          });
        }

        if (wallets.length > 0) {
          const withdrawalReferences = await Transaction.distinct("paystackTransferReference", {
            wallet: { $in: wallets.map((wallet) => wallet._id) },
            type: "withdrawal",
            provider: "paystack",
            paymentRail: "paystack_transfer",
            paystackTransferReference: { $type: "string" },
          }).session(session);

          if (withdrawalReferences.length > 0) {
            providerEventScopes.push({
              provider: "paystack",
              providerReference: { $in: withdrawalReferences },
            });
          }
        }

        const unresolvedProviderEvent = await ProviderEvent.exists({
          isVerified: true,
          eventCategory: {
            $in: [
              "transfer_unresolved",
              "professional_withdrawal_payout",
              "professional_withdrawal_reversal",
            ],
          },
          status: {
            $nin: ["processed"],
          },
          $or: providerEventScopes,
        }).session(session);

        if (unresolvedProviderEvent) {
          addBlocker(
            "ACCOUNT_CLOSURE_UNRECONCILED_PROVIDER_EVENTS",
            "Resolve outstanding withdrawal provider events before closing this account."
          );
        }

        if (
          wallets.some(
            (wallet) =>
              wallet.availableBalance !== 0 ||
              wallet.pendingBalance !== 0 ||
              wallet.outstandingBalance !== 0
          )
        ) {
          addBlocker(
            "ACCOUNT_CLOSURE_WALLET_BALANCE",
            "Clear available, pending and outstanding wallet balances before closure."
          );
        }

        if (wallets.some((wallet) => wallet.status === "frozen")) {
          addBlocker(
            "ACCOUNT_CLOSURE_FROZEN_WALLET",
            "A frozen wallet requires financial review before closure."
          );
        }

        if (wallets.length) {
          const walletIds = wallets.map((wallet) => wallet._id);

          const pendingWalletTransaction = await Transaction.exists({
            status: { $in: ["pending", "processing"] },
            $or: [{ wallet: { $in: walletIds } }, { counterpartyWallet: { $in: walletIds } }],
          }).session(session);

          if (pendingWalletTransaction) {
            addBlocker(
              "ACCOUNT_CLOSURE_PENDING_TRANSACTIONS",
              "Financial transactions are still pending or processing."
            );
          }
        }
      } else if (user.isOnboarded === true || user.professionalProfile) {
        addBlocker(
          "ACCOUNT_CLOSURE_PROFESSIONAL_PROFILE_MISSING",
          "Your professional profile requires reconciliation before closure."
        );
      }
    }

    if (user.role === "employer") {
      const [businessCount, membership] = await readClosureQueries(session, [
        EmployerProfile.countDocuments({ user: user._id, accountStatus: { $ne: "closed" } }),

        EmployerMember.findOne({ user: user._id, isCurrent: true })
          .select("_id role business accountStatus")
          .lean(),
      ]);

      ownedBusinessCount = businessCount;
      currentMembership = membership;

      if (ownedBusinessCount > 0) {
        addBlocker(
          "ACCOUNT_CLOSURE_BUSINESS_OWNERSHIP",
          "Close each owned business before closing this account."
        );
      }



      // Business wallets, protected funding, refunds and DVAs belong to the
      // business closure workflow, not to an invited member's personal closure.
    }

    if (user.role === "admin") {
      const otherActiveAdmins = await User.countDocuments({
        _id: { $ne: user._id },
        role: "admin",
        accountStatus: "active",
      }).session(session);

      if (otherActiveAdmins === 0) {
        addBlocker(
          "ACCOUNT_CLOSURE_LAST_ACTIVE_ADMIN",
          "The last active platform administrator cannot close their account."
        );
      }

      pendingChecks.push("independent_admin_approval", "admin_case_and_access_handover");
    }

    return {
      userId: String(user._id),
      role: user.role,
      accountStatus: user.accountStatus,
      professionalProfileId,
      ownedBusinessCount,
      currentMembershipId: currentMembership ? String(currentMembership._id) : null,
      currentMembershipRole: currentMembership?.role || null,
      walletCount,
      blockers,
      pendingChecks,
      canClose: blockers.length === 0 && pendingChecks.length === 0,
    };
  }

  /* ---------- ACCOUNT CLOSURE ---------- */

  static async closeAccount({ userId, confirmed = false } = {}) {
    if (confirmed !== true || !mongoose.isValidObjectId(userId)) {
      throw createServiceError({
        name: "AccountServiceError", code: "ACCOUNT_CLOSURE_CONFIRMATION_REQUIRED",
        message: "Explicit account closure confirmation is required.", statusCode: 400,
      });
    }

    return WalletService.runWithOptionalTransaction({}, async (session) => {
      const existing = await User.findById(userId)
        .select("_id accountStatus closedAt")
        .session(session);

      if (existing?.accountStatus === "closed") {
        return {
          userId: String(userId),
          closed: true,
          idempotent: true,
          closedAt: existing.closedAt
        };
      }

      const user = await User.findOneAndUpdate({
        _id: userId, accountStatus: "active", isVerified: true,
        role: { $in: ["professional", "employer"] },
      }, { $inc: { __v: 1 } }, { session, new: true }).select("_id role");

      if (!user) throw createServiceError({
        name: "AccountServiceError", code: "ACCOUNT_CLOSURE_FORBIDDEN",
        message: "This account requires manual closure review.", statusCode: 403,
      });

      // Coordinate closure with professional commitment-creating transactions.
      const professionalProfile = user.role === "professional"
        ? await ProfessionalProfile.findOneAndUpdate(
            { user: user._id },
            { $inc: { __v: 1 } },
            { session, new: true, timestamps: false }
          ).select("+licenceDocumentUrl +upcomingLicence.documentUrl")
        : null;

      const eligibility = await this.getAccountClosureEligibility({ userId, session });

      if (!eligibility.canClose) throw createServiceError({
        name: "AccountServiceError", code: "ACCOUNT_CLOSURE_BLOCKED",
        message: "Resolve outstanding commitments before account closure.",
        statusCode: 409, details: { eligibility },
      });

      const closedAt = new Date();

      if (user.role === "professional") {
        const profile = professionalProfile;

        if (profile) {
          const wallets = await Wallet.find({
            ownerType: "professional",
            professional: profile._id
          }).session(session);

          for (const wallet of wallets) {
            await WalletService.closeWalletForAccountClosure({
              walletId: wallet._id,
              ownerType: "professional",
              ownerProfileId: profile._id,
            }, { session });
          }

          if (profile.accountStatus !== "closed") {
            profile.accountStatus = "closed";
            profile.closedAt = closedAt;
            profile.accountStatusReason = "Account holder requested closure";
            profile.accountStatusUpdatedAt = closedAt;
            profile.accountStatusUpdatedBy = user._id;
            profile.marketplaceStatus = "hidden";
            profile.availabilityStatus = "unavailable";

            await profile.save({ session });
          }
        }
      } else {
        const member = await EmployerMember.findOne({
          user: user._id,
          isCurrent: true
        }).session(session);

        if (member) {
          const business = await EmployerProfile.findOneAndUpdate(
            { _id: member.business },
            { $inc: { __v: 1 } },
            { session, new: true }
          ).select("_id user");

          if (!business || String(business.user) === String(user._id)) {
            throw createServiceError({
              name: "AccountServiceError", code: "ACCOUNT_CLOSURE_MEMBERSHIP_CONFLICT",
              message: "The current membership requires reconciliation.", statusCode: 409,
            });
          }

          const removed = await EmployerMember.updateOne({
            _id: member._id,
            user: user._id,
            business: member.business,
            isCurrent: true,
            accountStatus: { $in: ["active", "restricted", "suspended"] },
          }, {
            $set: {
              accountStatus: "removed",
              isCurrent: false,
              removedAt: closedAt,
              removedBy: user._id,
              removalReason: "Personal account closure",
              updatedBy: user._id,
            },
            $inc: { __v: 1 }
          }, { session, runValidators: true });

          if (removed.modifiedCount !== 1) {
            throw new Error("Membership changed during closure.");
          }
        }
      }

      await User.closeForAccountClosure({
        userId: user._id,
        currentTime: closedAt
      }, { session });

      return {
        userId: String(user._id),
        closed: true,
        idempotent: false,
        closedAt
      };
    });
  }

  static async updateProfile({ userId, data = {} }) {
    if (!userId) {
      throw new Error("User is required.");
    }

    const user = await User.findById(userId);

    if (!user || user.accountStatus === "closed") {
      throw new Error("User not found or account is closed.");
    }

    const legalNameIsProtected =
      user.role === "professional" || user.legalNameSource === "nin_registry";

    const firstName = legalNameIsProtected ? user.firstName : String(data.firstName || "").trim();
    const lastName = legalNameIsProtected ? user.lastName : String(data.lastName || "").trim();
    const phoneCode = String(data.phoneCode || "").trim();
    const phoneNumber = String(data.phoneNumber || "").trim();

    if (!legalNameIsProtected && !firstName) {
      throw new Error("First name is required.");
    }

    if (!legalNameIsProtected && !lastName) {
      throw new Error("Last name is required.");
    }

    if (!phoneCode) {
      throw new Error("Phone code is required.");
    }

    if (!phoneNumber) {
      throw new Error("Phone number is required.");
    }

    // Professional legal names are supplied by trusted NIN onboarding only.
    // Contact updates must not rewrite legal identity or its display name.
    if (!legalNameIsProtected) {
      user.firstName = firstName;
      user.lastName = lastName;
      user.displayName = `${firstName} ${lastName}`.trim();
    }
    user.phoneCode = phoneCode;
    user.phoneNumber = phoneNumber;

    await user.save();

    return user;
  }

  static async updateProfilePhoto({ userId, photoUrl }) {
    if (!userId) {
      throw new Error("User is required.");
    }

    const photo = String(photoUrl || "").trim();

    if (!photo) {
      throw new Error("Profile photo is required.");
    }

    if (!this.isValidProfilePhotoPath(photo)) {
      throw new Error("Profile photo path is invalid.");
    }

    const user = await User.findById(userId);

    if (!user || user.accountStatus === "closed") {
      throw new Error("User not found or account is closed.");
    }

    user.photo = photo;

    await user.save();

    return user;
  }

  static async updatePassword({ userId, data }) {
    if (!userId) {
      throw new Error("User is required.");
    }

    const currentPassword = String(data.currentPassword || "");
    const newPassword = String(data.newPassword || "");
    const confirmPassword = String(data.confirmPassword || "");

    if (!currentPassword) {
      throw new Error("Current password is required.");
    }

    if (!newPassword) {
      throw new Error("New password is required.");
    }

    if (!confirmPassword) {
      throw new Error("Please confirm your new password.");
    }

    if (newPassword !== confirmPassword) {
      throw new Error("New password and confirmation do not match.");
    }

    if (!this.isStrongPassword(newPassword)) {
      throw new Error(
        "Password must be at least 8 characters and include uppercase, lowercase, and a number."
      );
    }

    const user = await User.findById(userId).select("+password");

    if (!user || user.accountStatus === "closed") {
      throw new Error("User not found or account is closed.");
    }

    if (user.authProvider === "google") {
      throw new Error(
        "This account uses Google login. Password changes should be made through Google."
      );
    }

    if (!user.password) {
      throw new Error("Password login is not enabled for this account.");
    }

    const isCurrentPasswordValid = await user.comparePassword(currentPassword);

    if (!isCurrentPasswordValid) {
      throw new Error("Current password is incorrect.");
    }

    const isSamePassword = await user.comparePassword(newPassword);

    if (isSamePassword) {
      throw new Error("New password must be different from your current password.");
    }

    user.password = newPassword;

    await user.save();

    return true;
  }

  static buildEmailChangeChallenge({ userId, currentEmail, newEmail, nonce, otp }) {
    const digest = crypto
      .createHash("sha256")
      .update(
        JSON.stringify(["email_change:v1", String(userId), currentEmail, newEmail, nonce, otp])
      )
      .digest("hex");

    return `email_change:v1:${nonce}:${digest}`;
  }

  static async sendChangeEmailOTP({ userId, newEmail }) {
    if (!userId) throw new Error("User is required.");

    const normalizedEmail = this.normalizeEmail(newEmail);
    if (!this.isValidEmail(normalizedEmail)) {
      throw new Error("Enter a valid email address.");
    }

    const user = await User.findById(userId);
    if (!user) throw new Error("User not found.");
    if (!["active", "restricted"].includes(user.accountStatus)) {
      throw new Error("This account is not permitted to change its email address.");
    }
    if (this.normalizeEmail(user.email) === normalizedEmail) {
      throw new Error("This is already your current email address.");
    }

    const existingUser = await User.findOne({
      email: normalizedEmail,
      _id: { $ne: user._id },
    });
    if (existingUser) {
      throw new Error("Another account already uses this email address.");
    }

    const now = new Date();
    const otp = crypto.randomInt(100000, 1000000).toString();
    const nonce = crypto.randomBytes(16).toString("hex");
    const challenge = this.buildEmailChangeChallenge({
      userId: user._id,
      currentEmail: user.email,
      newEmail: normalizedEmail,
      nonce,
      otp,
    });

    // Reuse the existing private OTP field, but store a purpose-bound digest.
    // The generic six-digit OTP verifier cannot accept this challenge.
    // A later OTP request replaces it, safely invalidating the email change.
    const claimed = await User.findOneAndUpdate(
      {
        _id: user._id,
        email: user.email,
        accountStatus: { $in: ["active", "restricted"] },
        $or: [
          { otpLastSentAt: null },
          { otpLastSentAt: { $lte: new Date(now.getTime() - 60 * 1000) } },
        ],
      },
      {
        $set: {
          otp: challenge,
          otpExpiry: new Date(now.getTime() + 10 * 60 * 1000),
          otpAttempts: 0,
          otpLastSentAt: now,
        },
        $inc: { __v: 1 },
      },
      { new: true, runValidators: true }
    );

    if (!claimed) {
      throw new Error(
        "Email change request could not be started. Please wait 60 seconds and try again."
      );
    }

    // Send only after successfully claiming the shared resend window.
    await EmailService.sendOTP(normalizedEmail, otp);
    return { newEmail: normalizedEmail };
  }

  static async confirmEmailChange({ userId, newEmail, otp }) {
    if (!userId) throw new Error("User is required.");

    const normalizedEmail = this.normalizeEmail(newEmail);
    if (!this.isValidEmail(normalizedEmail)) {
      throw new Error("Enter a valid email address.");
    }
    if (!otp) throw new Error("OTP is required.");

    const user = await User.findById(userId).select("+otp +otpExpiry");
    if (!user) throw new Error("User not found.");
    if (!["active", "restricted"].includes(user.accountStatus)) {
      throw new Error("This account is not permitted to change its email address.");
    }
    if (user.otpAttempts >= 5) {
      throw new Error("Too many attempts. Please request a new email-change OTP.");
    }

    const stored =
      typeof user.otp === "string"
        ? /^email_change:v1:([a-f0-9]{32}):([a-f0-9]{64})$/.exec(user.otp)
        : null;
    if (!stored || !user.otpExpiry || user.otpExpiry <= new Date()) {
      throw new Error("Email-change OTP has expired or was replaced. Please request a new one.");
    }

    const candidate = typeof otp === "string" || typeof otp === "number" ? String(otp).trim() : "";
    const expected = this.buildEmailChangeChallenge({
      userId: user._id,
      currentEmail: user.email,
      newEmail: normalizedEmail,
      nonce: stored[1],
      otp: candidate,
    });
    const matches =
      /^\d{6}$/.test(candidate) &&
      crypto.timingSafeEqual(Buffer.from(user.otp, "utf8"), Buffer.from(expected, "utf8"));

    // Compare-and-set protects against resends, concurrent confirmations,
    // expiry, account restrictions and changes to the current email address.
    const challengeFilter = () => ({
      _id: user._id,
      email: user.email,
      accountStatus: { $in: ["active", "restricted"] },
      otp: user.otp,
      otpLastSentAt: user.otpLastSentAt,
      otpExpiry: { $eq: user.otpExpiry, $gt: new Date() },
      otpAttempts: { $lt: 5 },
    });

    if (!matches) {
      const failed = await User.findOneAndUpdate(
        challengeFilter(),
        { $inc: { otpAttempts: 1, __v: 1 } },
        { new: true, runValidators: true }
      );
      if (!failed) {
        throw new Error("Email-change OTP is no longer available. Please request a new one.");
      }
      throw new Error(`Invalid email-change OTP. ${5 - failed.otpAttempts} attempts remaining.`);
    }

    const existingUser = await User.findOne({
      email: normalizedEmail,
      _id: { $ne: user._id },
    });
    if (existingUser) {
      throw new Error("Another account already uses this email address.");
    }

    try {
      // Consume the exact challenge and change the email in one atomic write.
      const updatedUser = await User.findOneAndUpdate(
        challengeFilter(),
        {
          $set: { email: normalizedEmail, isVerified: true, otpAttempts: 0 },
          $unset: { otp: 1, otpExpiry: 1 },
          $inc: { __v: 1 },
        },
        { new: true, runValidators: true }
      );
      if (!updatedUser) {
        throw new Error("Email-change OTP is no longer available. Please request a new one.");
      }
      return updatedUser;
    } catch (error) {
      if (error.code === 11000 && error.keyPattern?.email) {
        throw new Error("Another account already uses this email address.");
      }
      throw error;
    }
  }

  static async sendDisableTwoFactorOTP(userId) {
    if (!userId) {
      throw new Error("User is required.");
    }

    const user = await User.findById(userId);

    if (!user || user.accountStatus === "closed") {
      throw new Error("User not found or account is closed.");
    }

    if (!user.twoFactorEnabled) {
      throw new Error("Two-factor authentication is already disabled.");
    }

    await AuthService.sendOTP(user._id, { purpose: "disable_2fa", email: user.email });

    return true;
  }

  static async disableTwoFactor({ userId, otp }) {
    if (!userId) {
      throw new Error("User is required.");
    }

    if (!otp) {
      throw new Error("OTP is required.");
    }

    const existingUser = await User.findById(userId);

    if (!existingUser || existingUser.accountStatus === "closed") {
      throw new Error("User not found or account is closed.");
    }

    if (!existingUser.twoFactorEnabled) {
      throw new Error("Two-factor authentication is already disabled.");
    }

    return AuthService.verifyOTP(userId, otp, {
      purpose: "disable_2fa",
      email: existingUser.email,
    });
  }

  static async sendEnableTwoFactorOTP(userId) {
    if (!userId) {
      throw new Error("User is required.");
    }

    const user = await User.findById(userId);

    if (!user || user.accountStatus === "closed") {
      throw new Error("User not found or account is closed.");
    }

    if (user.twoFactorEnabled) {
      throw new Error("Two-factor authentication is already enabled.");
    }

    await AuthService.sendOTP(user._id, { purpose: "enable_2fa", email: user.email });

    return true;
  }

  static async enableTwoFactor({ userId, otp }) {
    if (!userId) {
      throw new Error("User is required.");
    }

    if (!otp) {
      throw new Error("OTP is required.");
    }

    const existingUser = await User.findById(userId);

    if (!existingUser || existingUser.accountStatus === "closed") {
      throw new Error("User not found or account is closed.");
    }

    if (existingUser.twoFactorEnabled) {
      throw new Error("Two-factor authentication is already enabled.");
    }

    return AuthService.verifyOTP(userId, otp, {
      purpose: "enable_2fa",
      email: existingUser.email,
    });
  }
}

module.exports = AccountService;
