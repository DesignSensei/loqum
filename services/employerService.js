// services/employerService.js

const mongoose = require("mongoose");
const Branch = require("../models/Branch");
const EmployerProfile = require("../models/EmployerProfile");
const EmployerMember = require("../models/EmployerMember");
const User = require("../models/User");
const ProfileInputService = require("./profileInputService");
const EmployerQueryService = require("./employerQueryService");
const EmployerViewService = require("./employerViewService");

function getEmployerProfileCoordinates(employerProfile) {
  const coordinates = employerProfile?.location?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return { longitude: "", latitude: "" };
  }
  return { longitude: coordinates[0] ?? "", latitude: coordinates[1] ?? "" };
}

function profileFieldChanged(oldValue, newValue) {
  return String(oldValue ?? "").trim() !== String(newValue ?? "").trim();
}

/*
 * The previous business profile update method
 * allowed applicants to change businessName
 * and CAC registration details and automatically
 * reset verification states.
 *
 * That is no longer permitted.
 *
 * Legal registration and regulatory identities
 * require dedicated authorised workflows.
 *
 * This helper now detects material changes
 * without automatically clearing evidence,
 * administrative restrictions or approval history.
 */

function getBusinessDetailsVerificationReset(oldProfile, profileData) {
  const cacChanged =
    profileFieldChanged(oldProfile.businessName, profileData.businessName) ||
    profileFieldChanged(oldProfile.cacRegistrationNumber, profileData.cacRegistrationNumber);

  // Facility type is protected. Historical employer-wide regulatory fields
  // are not regenerated or compared during ordinary contact edits; older
  // profiles may not have them, while input validation may infer an authority.
  const regulatoryChanged = profileFieldChanged(oldProfile.type, profileData.type);

  const coordinates = getEmployerProfileCoordinates(oldProfile);

  const premisesChanged =
    profileFieldChanged(oldProfile.address, profileData.address) ||
    profileFieldChanged(oldProfile.googlePlaceId, profileData.googlePlaceId) ||
    profileFieldChanged(oldProfile.state, profileData.state) ||
    profileFieldChanged(oldProfile.lga, profileData.lga) ||
    Number(coordinates.latitude) !== Number(profileData.location?.coordinates?.[1]) ||
    Number(coordinates.longitude) !== Number(profileData.location?.coordinates?.[0]);

  const representativeChanged =
    profileFieldChanged(oldProfile.contactFirstName, profileData.contactFirstName) ||
    profileFieldChanged(oldProfile.contactLastName, profileData.contactLastName) ||
    profileFieldChanged(oldProfile.contactRole, profileData.contactRole);

  return {
    cacChanged,
    regulatoryChanged,
    premisesChanged,
    representativeChanged,

    /*
     * Ordinary editing must not silently
     * reset verification decisions or deactivate
     * previously authoritative KYC evidence.
     */

    update: {},
    invalidatedTypes: [],
  };
}

function normalizeProtectedBusinessName(value) {
  return typeof value === "string" ? value.normalize("NFC").trim() : "";
}

function normalizeProtectedCACNumber(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, "");
}

function normalizeProtectedRegulatoryNumber(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeProtectedType(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function assertProtectedBusinessIdentityUnchanged(employerProfile, data) {
  const protectedFields = [
    { field: "type", normalize: normalizeProtectedType },
    { field: "businessName", normalize: normalizeProtectedBusinessName },
    { field: "cacRegistrationNumber", normalize: normalizeProtectedCACNumber },
    { field: "regulatoryBody", normalize: normalizeProtectedType },
    {
      field: "regulatoryRegistrationNumber",
      normalize: normalizeProtectedRegulatoryNumber,
    },
  ];

  for (const { field, normalize } of protectedFields) {
    if (!Object.prototype.hasOwnProperty.call(data, field)) {
      continue;
    }

    const storedValue =
      field === "regulatoryBody" && !employerProfile.regulatoryBody
        ? ProfileInputService.getRegulatoryBody(employerProfile.type, employerProfile.state)
        : employerProfile[field];
    if (normalize(data[field]) !== normalize(storedValue)) {
      throw new Error(
        `${field} cannot be changed through ordinary business profile editing. Please contact support.`
      );
    }
  }
}

function assertNoProtectedStateUpdates(data) {
  const protectedFields = [
    "user",
    "_id",
    "countryCode",
    "currency",

    "cacVerificationStatus",
    "cacVerificationMethod",
    "cacVerificationSource",
    "cacNameOnRecord",
    "cacVerifiedAt",
    "cacLastCheckedAt",
    "cacVerifiedBy",
    "cacVerificationNote",
    "cacRejectionReason",

    "regulatoryVerificationStatus",
    "regulatoryVerificationMethod",
    "regulatoryVerificationSource",
    "regulatoryNameOnRecord",
    "regulatoryVerifiedAt",
    "regulatoryLastCheckedAt",
    "regulatoryVerifiedBy",
    "regulatoryVerificationNote",
    "regulatoryRejectionReason",

    "employerApprovalStatus",
    "employerApprovalStatusUpdatedAt",
    "employerApprovalStatusUpdatedBy",
    "approvedToPostShiftsAt",
    "approvedToPostShiftsBy",
    "employerApprovalNote",
    "employerRejectionReason",

    "accountStatus",
    "accountStatusReason",
    "accountStatusUpdatedAt",
    "accountStatusUpdatedBy",

    "totalShiftsPaid",
    "totalAmountFunded",
    "totalAmountSpent",
    "totalProfessionalPayFunded",
    "totalPlatformFeesPaid",
    "totalRefundedAmount",

    "averageRating",
    "totalReviews",
    "reviews",
    "totalShiftsPosted",
    "totalShiftsCompleted",
    "activeShiftCount",
    "lastShiftPostedAt",
    "lastShiftCompletedAt",
  ];

  for (const field of protectedFields) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      throw new Error(
        "Verification, financial and administrative fields cannot be updated through business details."
      );
    }
  }
}

function buildEditableEmployerProfileInput(employerProfile, data) {
  const coordinates = getEmployerProfileCoordinates(employerProfile);

  return {
    type: employerProfile.type,
    businessName: employerProfile.businessName,
    businessEmail: data.businessEmail ?? employerProfile.businessEmail,
    cacRegistrationNumber: employerProfile.cacRegistrationNumber,
    regulatoryRegistrationNumber: employerProfile.regulatoryRegistrationNumber,

    state: data.state ?? employerProfile.state,
    lga: data.lga ?? employerProfile.lga,
    address: data.address ?? employerProfile.address,

    latitude: data.latitude ?? coordinates.latitude,
    longitude: data.longitude ?? coordinates.longitude,
    googlePlaceId: data.googlePlaceId ?? employerProfile.googlePlaceId,

    businessPhoneCode: data.businessPhoneCode ?? employerProfile.businessPhoneCode,
    businessPhone: data.businessPhone ?? employerProfile.businessPhone,

    contactFirstName: data.contactFirstName ?? employerProfile.contactFirstName,
    contactLastName: data.contactLastName ?? employerProfile.contactLastName,
    contactRole: data.contactRole ?? employerProfile.contactRole,
    contactPhoneCode: data.contactPhoneCode ?? employerProfile.contactPhoneCode,
    contactPhone: data.contactPhone ?? employerProfile.contactPhone,
  };
}

class EmployerService {
  static async getDashboardData(employerProfile, options = {}) {
    if (!employerProfile) throw new Error("Employer profile is required to load dashboard.");

    const access = await EmployerQueryService.resolveEmployerDataAccess({
      employerProfile,
      actorUserId: options.actorUserId,
      employerContext: options.employerContext,
    });

    const queries = await EmployerQueryService.getDashboardQueries({
      access,
      countEligibleBranches:
        access.cacVerificationStatus === "verified" && access.businessAccountStatus === "active",
    });

    return EmployerViewService.buildDashboardData({ employerProfile, access, queries });
  }

  static async getBusinessProfileData(employerProfile, options = {}) {
    if (!employerProfile) {
      throw new Error("Employer profile is required to load business profile.");
    }

    const access = await EmployerQueryService.resolveEmployerDataAccess({
      employerProfile,
      actorUserId: options.actorUserId,
      employerContext: options.employerContext,
    });

    const activeTab = options.activeTab || "overview";
    const branchStatus = EmployerQueryService.normalizeBranchStatusFilter(options.branchStatus);
    const memberStatus = EmployerQueryService.normalizeMemberStatusFilter(options.memberStatus);

    const queries = await EmployerQueryService.getBusinessProfileQueries({
      access,
      activeTab,
      branchStatus,
      memberStatus,
      inviteStatus: options.inviteStatus || "active",
    });

    const branchVerificationItems = EmployerViewService.buildBranchPermitVerificationItems(
      queries.branchReadinessRows,
      access
    );

    return EmployerViewService.buildBusinessProfileView({
      employerProfile,
      activeTab,
      access,
      branchStatus,
      memberStatus,
      branchVerificationItems,

      branches: queries.branches,
      branchStatusCounts: queries.branchStatusCounts,

      members: queries.members,
      activeCurrentMembers: queries.activeCurrentMembers,
      memberStatusCounts: queries.memberStatusCounts,

      inviteView: queries.inviteView,
      pendingInvitesCount: queries.pendingInvitesCount,

      wallet: queries.wallet,
      defaultDva: queries.defaultDva,
    });
  }

  // Existing public entry points remain available.
  static buildDashboardView(args) {
    return EmployerViewService.buildDashboardView(args);
  }

  static getAlertView(type) {
    return EmployerViewService.getAlertView(type);
  }

  static formatDate(value) {
    return EmployerViewService.formatDate(value);
  }

  static formatMinorUnitMoney(value) {
    return EmployerViewService.formatMinorUnitMoney(value);
  }

  static getBranchStatusCounts(businessId, assignedBranchIds = null) {
    return EmployerQueryService.getBranchStatusCounts(businessId, assignedBranchIds);
  }

  static getMemberStatusCounts(businessId) {
    return EmployerQueryService.getMemberStatusCounts(businessId);
  }

  static buildBusinessProfileView(args) {
    return EmployerViewService.buildBusinessProfileView(args);
  }

  static async assertCanEditBusinessDetails({ employerProfile, actorUserId, session }) {
    if (!mongoose.isValidObjectId(actorUserId)) {
      throw new Error("An authenticated user is required to update business details.");
    }

    if (employerProfile.accountStatus !== "active") {
      throw new Error("This business account is not eligible for profile editing.");
    }

    const actorFilter = {
      _id: actorUserId,
      role: "employer",
      accountStatus: "active",
      isVerified: true,
    };

    // Coordinate this authorization decision with concurrent account changes.
    const actorQuery = session
      ? User.findOneAndUpdate(
          actorFilter,
          { $inc: { __v: 1 } },
          {
            new: true,
            session,
            timestamps: false,
          }
        )
      : User.findOne(actorFilter);
    const actor = await actorQuery.select("_id");

    if (!actor) {
      throw new Error("Your account is not eligible to update business details.");
    }

    const isOwner = String(employerProfile.user) === String(actorUserId);

    if (isOwner) {
      return true;
    }

    const memberFilter = {
      business: employerProfile._id,
      user: actorUserId,
      role: "admin",
      accountStatus: "active",
      isCurrent: true,
    };

    // A demotion or removal must conflict with an in-flight profile edit.
    const memberQuery = session
      ? EmployerMember.findOneAndUpdate(
          memberFilter,
          { $inc: { __v: 1 } },
          {
            new: true,
            session,
            timestamps: false,
          }
        )
      : EmployerMember.findOne(memberFilter);
    const membership = await memberQuery.select("_id");

    if (!membership) {
      throw new Error("You are not authorised to update this business profile.");
    }

    return true;
  }

  static async updateBusinessDetails({ employerProfileId, actorUserId, data } = {}) {
    if (!mongoose.isValidObjectId(employerProfileId)) {
      throw new Error("A valid employer profile is required.");
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Valid business profile details are required.");
    }

    const session = await mongoose.startSession();
    let employerProfile;

    try {
      await session.withTransaction(async () => {
        employerProfile = await EmployerProfile.findById(employerProfileId).session(session);

        if (!employerProfile) {
          throw new Error("Employer profile not found.");
        }

        await this.assertCanEditBusinessDetails({
          employerProfile,
          actorUserId,
          session,
        });

        assertNoProtectedStateUpdates(data);
        assertProtectedBusinessIdentityUnchanged(employerProfile, data);

        const input = buildEditableEmployerProfileInput(employerProfile, data);
        const profileData = ProfileInputService.buildEmployerProfileData(input);
        const changes = getBusinessDetailsVerificationReset(employerProfile, profileData);

        if (changes.cacChanged || changes.regulatoryChanged) {
          throw new Error(
            "Business registration or regulatory identity changes require a separate verification process."
          );
        }

        if (changes.premisesChanged) {
          const primaryBranchExists = await Branch.exists({
            business: employerProfile._id,
            isPrimary: true,
          }).session(session);

          if (primaryBranchExists) {
            throw new Error(
              "Change the main facility's location through Branch management so its permits can be reassessed."
            );
          }

          const regulatoryReviewStarted = Boolean(
            (employerProfile.regulatoryVerificationStatus &&
              !["pending", "not_started"].includes(employerProfile.regulatoryVerificationStatus)) ||
            (employerProfile.regulatoryVerificationMethod &&
              employerProfile.regulatoryVerificationMethod !== "not_checked") ||
            (employerProfile.regulatoryVerificationSource &&
              employerProfile.regulatoryVerificationSource !== "not_checked") ||
            employerProfile.regulatoryLastCheckedAt ||
            employerProfile.regulatoryVerifiedAt
          );

          if (regulatoryReviewStarted) {
            throw new Error(
              "Changes to reviewed business premises require additional regulatory review. Please contact support."
            );
          }
        }

        // Only ordinary contact and permitted location fields are persisted.
        const updates = {
          businessEmail: profileData.businessEmail,
          businessPhoneCode: profileData.businessPhoneCode,
          businessPhone: profileData.businessPhone,

          address: profileData.address,
          googlePlaceId: profileData.googlePlaceId,
          location: profileData.location,
          state: profileData.state,
          lga: profileData.lga,

          contactFirstName: profileData.contactFirstName,
          contactLastName: profileData.contactLastName,
          contactRole: profileData.contactRole,
          contactPhoneCode: profileData.contactPhoneCode,
          contactPhone: profileData.contactPhone,
        };

        employerProfile.set(updates);
        await employerProfile.save({ session });
      });

      return employerProfile;
    } finally {
      await session.endSession();
    }
  }
}

module.exports = EmployerService;
