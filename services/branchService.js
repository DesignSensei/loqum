// services/branchService.js

const mongoose = require("mongoose");

const Branch = require("../models/Branch");
const FacilityPermit = require("../models/FacilityPermit");
const EmployerMember = require("../models/EmployerMember");
const EmployerProfile = require("../models/EmployerProfile");
const User = require("../models/User");
const PlatformSettings = require("../models/PlatformSettings");

function createBranchError(message, statusCode = 400) {
  const error = new Error(message);
  error.name = "BranchServiceError";
  error.statusCode = statusCode;
  return error;
}

class BranchService {
  static async getActivePlatformSettings() {
    const settings = await PlatformSettings.findOne({
      key: "global",
      isActive: true,
    });

    if (!settings) {
      throw new Error("Active platform settings could not be found.");
    }

    return settings;
  }

  static async getGeofencePolicy() {
    const settings = await BranchService.getActivePlatformSettings();

    const defaultRadius = Number(settings.defaultGeofenceRadiusMeters);
    const minimumRadius = Number(settings.minimumGeofenceRadiusMeters);
    const maximumRadius = Number(settings.maximumGeofenceRadiusMeters);

    return {
      defaultRadius: Number.isSafeInteger(defaultRadius) ? defaultRadius : 100,
      minimumRadius: Number.isSafeInteger(minimumRadius) ? minimumRadius : 20,
      maximumRadius: Number.isSafeInteger(maximumRadius) ? maximumRadius : 1000,
    };
  }

  static parseCoordinate(value) {
    if (value === undefined || value === null || String(value).trim() === "") {
      return null;
    }

    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
  }

  static parseGeofenceRadius(value, defaultRadius = 100) {
    if (value === undefined || value === null || String(value).trim() === "") {
      return defaultRadius;
    }

    const radius = Number(value);
    return Number.isFinite(radius) ? radius : null;
  }

  static async normalizeBranchPayload(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw createBranchError("Branch details are required.");
    }

    const geofencePolicy = await BranchService.getGeofencePolicy();
    const longitude = BranchService.parseCoordinate(body.longitude);
    const latitude = BranchService.parseCoordinate(body.latitude);
    const geofenceRadiusMeters = BranchService.parseGeofenceRadius(
      body.geofenceRadiusMeters,
      geofencePolicy.defaultRadius
    );

    const hasValidCoordinates =
      longitude !== null &&
      latitude !== null &&
      longitude >= -180 &&
      longitude <= 180 &&
      latitude >= -90 &&
      latitude <= 90;

    const contactPhone = String(body.contactPhone || "").trim();
    const contactPhoneCode = contactPhone ? String(body.contactPhoneCode || "").trim() : "";

    return {
      payload: {
        name: String(body.name || "").trim(),
        address: String(body.address || "").trim(),
        googlePlaceId: String(body.googlePlaceId || "").trim(),
        state: String(body.state || "").trim(),
        lga: String(body.lga || "").trim(),
        contactPhoneCode,
        contactPhone,
        geofenceRadiusMeters,
        location: hasValidCoordinates
          ? { type: "Point", coordinates: [longitude, latitude] }
          : undefined,
      },
      geofencePolicy,
    };
  }

  static validateBranchPayload(payload, geofencePolicy) {
    if (!payload.name) throw createBranchError("Branch name is required.");
    if (!payload.address) throw createBranchError("Branch address is required.");
    if (!payload.googlePlaceId) {
      throw createBranchError("Please select a valid address from the address suggestions.");
    }
    if (!payload.state) throw createBranchError("State is required.");
    if (!payload.lga) throw createBranchError("LGA is required.");

    // Match the persisted Branch schema limits before reaching Mongoose save().
    // Invalid user input should return a validation error, not a server error.
    const textLimits = [
      ["name", 120, "Branch name"],
      ["address", 250, "Branch address"],
      ["googlePlaceId", 250, "Google Place ID"],
      ["state", 100, "State"],
      ["lga", 100, "LGA"],
      ["contactPhoneCode", 10, "Contact phone code"],
      ["contactPhone", 30, "Contact phone number"],
    ];

    for (const [field, maxLength, label] of textLimits) {
      if (payload[field] && payload[field].length > maxLength) {
        throw createBranchError(`${label} cannot exceed ${maxLength} characters.`);
      }
    }

    if (!payload.location || !Array.isArray(payload.location.coordinates)) {
      throw createBranchError("Please select a valid address from the address suggestions.");
    }

    const [longitude, latitude] = payload.location.coordinates;
    if (
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180 ||
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90
    ) {
      throw createBranchError("Branch coordinates are invalid.");
    }

    if (
      payload.geofenceRadiusMeters === null ||
      !Number.isSafeInteger(payload.geofenceRadiusMeters)
    ) {
      throw createBranchError("Geofence radius must be a whole number.");
    }

    if (
      payload.geofenceRadiusMeters < geofencePolicy.minimumRadius ||
      payload.geofenceRadiusMeters > geofencePolicy.maximumRadius
    ) {
      throw createBranchError(
        `Geofence radius must be between ${geofencePolicy.minimumRadius} and ${geofencePolicy.maximumRadius} meters.`
      );
    }

    if (payload.contactPhone && !payload.contactPhoneCode) {
      throw createBranchError(
        "Contact phone code is required when a contact phone number is provided."
      );
    }

    if (payload.contactPhoneCode && !/^\+\d{1,4}$/.test(payload.contactPhoneCode)) {
      throw createBranchError("Contact phone code must be a valid international dialing code.");
    }

    if (payload.contactPhoneCode && !payload.contactPhone) {
      throw createBranchError(
        "Contact phone number is required when a contact phone code is provided."
      );
    }
  }

  static async getBranchesForBusiness(businessId) {
    return Branch.find({ business: businessId }).sort({ createdAt: -1 });
  }

  static async getBranchForBusiness({ branchId, businessId, session = null }) {
    if (!mongoose.isValidObjectId(branchId) || !mongoose.isValidObjectId(businessId)) {
      throw createBranchError("Valid branch and employer business IDs are required.");
    }

    const query = Branch.findOne({ _id: branchId, business: businessId });
    if (session) query.session(session);

    const branch = await query;
    if (!branch) throw createBranchError("Branch not found.", 404);
    return branch;
  }

  static async createBranch({ businessId, body, actorUserId }) {
    if (!businessId) throw createBranchError("Business ID is required.");

    await BranchService.assertCanManageBranches({ businessId, actorUserId });

    const { payload, geofencePolicy } = await BranchService.normalizeBranchPayload(body);
    BranchService.validateBranchPayload(payload, geofencePolicy);

    // isPrimary is reserved for the initial branch created by onboarding.
    // No form value can turn a subsequently added branch into a primary branch.
    const branch = new Branch({ business: businessId, ...payload, isPrimary: false });
    await branch.save();
    return branch;
  }

  static hasOwnField(body, fieldName) {
    return Object.prototype.hasOwnProperty.call(body || {}, fieldName);
  }

  static syncMemberTopLevelRole(member) {
    if (member.role === "admin") {
      member.branches = [];
      return;
    }

    const hasManagerBranch = member.branches.some(
      (assignment) => assignment.role === "branch_manager"
    );
    member.role = hasManagerBranch ? "branch_manager" : "branch_staff";
  }

  static applyBranchPayload(branch, payload) {
    branch.name = payload.name;
    branch.address = payload.address;
    branch.googlePlaceId = payload.googlePlaceId;
    branch.state = payload.state;
    branch.lga = payload.lga;
    branch.contactPhoneCode = payload.contactPhoneCode;
    branch.contactPhone = payload.contactPhone;
    branch.location = payload.location;
    branch.geofenceRadiusMeters = payload.geofenceRadiusMeters;
  }

  // ───────────────────── PHYSICAL PREMISES CHANGE ─────────────────────

  /*
   * Permit evidence is tied to a physical premises, not to a branch label.
   * A changed address, state, LGA, Google Place ID or coordinates is
   * treated as a location change. A contact/name/geofence change is not.
   *
   * Compare against the current persisted branch within the transaction,
   * never against untrusted fields from the request.
   */
  static hasPhysicalLocationChanged(branch, payload) {
    const textFields = ["address", "state", "lga", "googlePlaceId"];

    if (textFields.some((field) => branch[field] !== payload[field])) {
      return true;
    }

    const previous = branch.location?.coordinates;
    const next = payload.location?.coordinates;

    return (
      !Array.isArray(previous) ||
      !Array.isArray(next) ||
      previous.length !== 2 ||
      next.length !== 2 ||
      Number(previous[0]) !== Number(next[0]) ||
      Number(previous[1]) !== Number(next[1])
    );
  }

  /*
   * A current facility permit must not remain active after the premises
   * changes. Preserve its verified review history, but close its current
   * activation. Do not mark this as regulatory revocation or rejection.
   *
   * All saves occur in the SAME transaction as the Branch location update.
   * A conflict or validation error rolls back the entire edit.
   *
   * Future-approved, noncurrent permits remain historical submissions;
   * the verification/marketplace services MUST check each permit's saved
   * premises snapshot against the current branch before activation or use.
   */
  static async deactivateCurrentPermitsForLocationChange({ branch, session }) {
    if (!session || !session.inTransaction()) {
      throw new Error("A transaction is required to deactivate branch permits.");
    }

    const currentPermits = await FacilityPermit.find({
      business: branch.business,
      branch: branch._id,
      isCurrent: true,
    }).session(session);

    if (!currentPermits.length) {
      return 0;
    }

    const now = new Date();

    for (const permit of currentPermits) {
      permit.isCurrent = false;
      permit.deactivatedAt = now;
      await permit.save({ session });
    }

    return currentPermits.length;
  }

  // Every branch mutation requires an active verified employer actor
  // with current business-wide authority. A branch manager alone
  // cannot create, edit or manage branches.
  static async assertCanManageBranches({ businessId, actorUserId, session = null }) {
    if (!mongoose.isValidObjectId(businessId)) {
      throw createBranchError("Valid employer business ID is required.");
    }

    if (!mongoose.isValidObjectId(actorUserId)) {
      throw createBranchError(
        "Authenticated employer user ID is required to manage branches.",
        401
      );
    }

    const actor = await User.findOne({
      _id: actorUserId,
      role: "employer",
      accountStatus: "active",
      isVerified: true,
    })
      .select("_id")
      .session(session)
      .lean();

    const business = await EmployerProfile.findById(businessId)
      .select("_id user accountStatus")
      .session(session)
      .lean();

    if (!actor || !business || business.accountStatus !== "active") {
      throw createBranchError(
        "An active employer business and verified employer account are required.",
        403
      );
    }

    if (String(business.user) === String(actor._id)) {
      return;
    }

    const adminMember = await EmployerMember.findOne({
      user: actor._id,
      business: business._id,
      role: "admin",
      accountStatus: "active",
      isCurrent: true,
    })
      .select("_id")
      .session(session)
      .lean();

    if (!adminMember) {
      throw createBranchError(
        "Only the business owner or an active business administrator can manage branches.",
        403
      );
    }
  }

  static async assertCanManageBranchManagers(options) {
    return BranchService.assertCanManageBranches(options);
  }

  static async updateBranchManager({
    branchId,
    businessId,
    managerMemberId,
    actorUserId,
    session = null,
  }) {
    if (!mongoose.isValidObjectId(branchId) || !mongoose.isValidObjectId(businessId)) {
      throw createBranchError("Valid branch and employer business IDs are required.");
    }

    if (typeof managerMemberId !== "string") {
      throw createBranchError("Manager selection is required. Use an empty string to unassign.");
    }

    const selectedManagerId = managerMemberId.trim();
    if (selectedManagerId && !mongoose.isValidObjectId(selectedManagerId)) {
      throw createBranchError("Invalid manager selection.");
    }

    const execute = async (tx) => {
      await BranchService.assertCanManageBranchManagers({
        businessId,
        actorUserId,
        session: tx,
      });

      // Shared write coordination with TeamMemberService and InviteService.
      // A MongoDB write conflict aborts a competing transaction, rather than
      // allowing two conflicting manager assignments to commit.
      const branch = await Branch.findOneAndUpdate(
        { _id: branchId, business: businessId },
        { $currentDate: { updatedAt: true } },
        { session: tx, new: true, timestamps: false }
      ).select("_id");

      if (!branch) throw createBranchError("Branch not found for this business.", 404);

      let newManager = null;
      if (selectedManagerId) {
        newManager = await EmployerMember.findOne({
          _id: selectedManagerId,
          business: businessId,
          accountStatus: "active",
          isCurrent: true,
        }).session(tx);

        if (!newManager) {
          throw createBranchError("Selected manager was not found among active current members.");
        }

        if (newManager.role === "admin") {
          throw createBranchError(
            "Business administrators cannot be assigned to individual branches."
          );
        }

        const eligibleUser = await User.findOne({
          _id: newManager.user,
          role: "employer",
          accountStatus: "active",
          isVerified: true,
        })
          .select("_id")
          .session(tx)
          .lean();

        if (!eligibleUser) {
          throw createBranchError(
            "Selected manager does not have an active verified employer account."
          );
        }
      }

      // Include restricted and suspended current assignments so they
      // cannot silently regain obsolete manager authority on reactivation.
      const existingManagers = await EmployerMember.find({
        business: businessId,
        isCurrent: true,
        accountStatus: { $in: ["active", "restricted", "suspended"] },
        branches: {
          $elemMatch: { branch: branchId, role: "branch_manager" },
        },
      }).session(tx);

      for (const member of existingManagers) {
        if (selectedManagerId && String(member._id) === selectedManagerId) {
          continue;
        }

        let changed = false;
        for (const assignment of member.branches) {
          if (
            String(assignment.branch) === String(branchId) &&
            assignment.role === "branch_manager"
          ) {
            assignment.role = "branch_staff";
            changed = true;
          }
        }

        if (changed) {
          BranchService.syncMemberTopLevelRole(member);
          member.updatedBy = actorUserId;
          await member.save({ session: tx });
        }
      }

      // An empty selection intentionally unassigns all current managers.
      if (!newManager) return null;

      const assignment = newManager.branches.find(
        (item) => String(item.branch) === String(branchId)
      );

      if (assignment) {
        assignment.role = "branch_manager";
        assignment.assignedAt = assignment.assignedAt || new Date();
      } else {
        newManager.branches.push({
          branch: branchId,
          role: "branch_manager",
          assignedAt: new Date(),
        });
      }

      newManager.role = "branch_manager";
      newManager.updatedBy = actorUserId;
      await newManager.save({ session: tx });
      return newManager;
    };

    if (session) {
      return execute(session);
    }

    const ownSession = await mongoose.startSession();
    try {
      let updatedManager;
      await ownSession.withTransaction(async () => {
        updatedManager = await execute(ownSession);
      });
      return updatedManager;
    } finally {
      await ownSession.endSession();
    }
  }

  static async updateBranch({ branchId, businessId, body, actorUserId }) {
    if (!mongoose.isValidObjectId(branchId)) {
      throw createBranchError("Valid branch ID is required.");
    }
    if (!mongoose.isValidObjectId(businessId)) {
      throw createBranchError("Valid employer business ID is required.");
    }

    const { payload, geofencePolicy } = await BranchService.normalizeBranchPayload(body);

    // An omitted or blank radius on EDIT means "keep the saved radius".
    // On CREATE, normalizeBranchPayload still uses the platform default.
    const preserveExistingRadius =
      !BranchService.hasOwnField(body, "geofenceRadiusMeters") ||
      body.geofenceRadiusMeters === null ||
      String(body.geofenceRadiusMeters).trim() === "";

    const updatingManager = BranchService.hasOwnField(body, "managerMemberId");

    /*
     * Branch details and optional manager replacement have always
     * supported combined editing. Now ALL branch edits are transactional
     * so any premises move also deactivates current permits atomically.
     *
     * This does not automatically approve a permit for the new location.
     * The separate post-onboarding permit workflow must handle that.
     */
    const session = await mongoose.startSession();
    try {
      let updatedBranch;

      await session.withTransaction(async () => {
        await BranchService.assertCanManageBranches({
          businessId,
          actorUserId,
          session,
        });

        const branch = await BranchService.getBranchForBusiness({
          branchId,
          businessId,
          session,
        });

        if (preserveExistingRadius) {
          payload.geofenceRadiusMeters =
            branch.geofenceRadiusMeters == null
              ? geofencePolicy.defaultRadius
              : branch.geofenceRadiusMeters;
        }

        BranchService.validateBranchPayload(payload, geofencePolicy);

        const premisesChanged = BranchService.hasPhysicalLocationChanged(branch, payload);

        BranchService.applyBranchPayload(branch, payload);
        await branch.save({ session });

        // Deactivation is part of the location change, not a separate
        // best-effort operation that could leave old approvals active.
        if (premisesChanged) {
          await BranchService.deactivateCurrentPermitsForLocationChange({
            branch,
            session,
          });
        }

        if (updatingManager) {
          await BranchService.updateBranchManager({
            branchId,
            businessId,
            managerMemberId: body.managerMemberId,
            actorUserId,
            session,
          });
        }

        updatedBranch = branch;
      });

      return updatedBranch;
    } finally {
      await session.endSession();
    }
  }

  // ───────────────────── ADMINISTRATIVE BRANCH STATUS ─────────────────────

  /*
   * The branch's isActive flag is an administrative availability control.
   * It is not a CAC decision, a facility permit approval, or a change of
   * premises. Do not modify permit records or existing shift obligations.
   *
   * Eligibility to post new shifts must still be enforced independently
   * by the applicable marketplace and regulatory readiness services.
   * Reactivation does not reactivate previously deactivated permits.
   *
   * Strictly scope the target branch to the authenticated business and
   * recheck owner/admin authority inside the same transaction as the write.
   * Repeated requests for the current state are intentionally idempotent.
   */
  static async setBranchActiveStatus({ branchId, businessId, actorUserId, isActive }) {
    if (!mongoose.isValidObjectId(branchId)) {
      throw createBranchError("Valid branch ID is required.");
    }

    if (!mongoose.isValidObjectId(businessId)) {
      throw createBranchError("Valid employer business ID is required.");
    }

    if (typeof isActive !== "boolean") {
      throw createBranchError("Branch active status must be true or false.");
    }

    const session = await mongoose.startSession();

    try {
      let updatedBranch;

      await session.withTransaction(async () => {
        await BranchService.assertCanManageBranches({
          businessId,
          actorUserId,
          session,
        });

        const branch = await BranchService.getBranchForBusiness({
          branchId,
          businessId,
          session,
        });

        if (branch.isActive !== isActive) {
          branch.isActive = isActive;
          await branch.save({ session });
        }

        updatedBranch = branch;
      });

      return updatedBranch;
    } finally {
      await session.endSession();
    }
  }

  /* ---------- Business closure offboarding ---------- */

  static async deactivateForBusinessClosure({ businessId, actorUserId, session }) {
    if (
      !session?.inTransaction?.() ||
      !mongoose.isValidObjectId(businessId) ||
      !mongoose.isValidObjectId(actorUserId)
    ) {
      throw new Error("Business closure requires valid ownership and an active transaction.");
    }

    const business = await EmployerProfile.findOne({
      _id: businessId,
      user: actorUserId,
      accountStatus: "closed",
    }).select("_id closedAt").session(session);

    if (!business?.closedAt) {
      throw new Error("The business must be marked closed within the final closure transaction.");
    }

    const branches = await Branch.find({ business: businessId }).session(session);
    const permits = await FacilityPermit.find({
      business: businessId,
      isCurrent: true,
    }).session(session);

    const branchIds = new Set(branches.map((branch) => String(branch._id)));
    const now = new Date();

    let branchesDeactivated = 0;

    for (const permit of permits) {
      if (!branchIds.has(String(permit.branch))) {
        throw new Error("Facility permit ownership requires reconciliation.");
      }

      // Preserve regulatory verification and original premises evidence.
      permit.isCurrent = false;
      permit.deactivatedAt = now;
      await permit.save({ session });
    }

    for (const branch of branches) {
      if (branch.isActive !== true) continue;

      branch.isActive = false;
      await branch.save({ session });
      branchesDeactivated++;
    }

    return {
      branchesDeactivated,
      permitsDeactivated: permits.length,
    };
  }

  static async getBranchMembers({ branchId, businessId }) {
    await BranchService.getBranchForBusiness({ branchId, businessId });

    return EmployerMember.find({
      business: businessId,
      isCurrent: true,
      accountStatus: { $ne: "removed" },
      "branches.branch": branchId,
    })
      .populate("user", "firstName lastName email displayName")
      .sort({ createdAt: -1 });
  }
}

module.exports = BranchService;
