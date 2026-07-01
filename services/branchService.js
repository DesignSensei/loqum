// services/branchService.js

const Branch = require("../models/Branch");
const EmployerMember = require("../models/EmployerMember");
const PlatformSettings = require("../models/PlatformSettings");

class BranchService {
  /* ---------- Get geofence policy from platform settings ---------- */
  static async getGeofencePolicy() {
    const settings = await PlatformSettings.findOne({
      key: "global",
      isActive: true,
    }).lean();

    const defaultRadius = Number(settings?.defaultGeofenceRadiusMeters);
    const minimumRadius = Number(settings?.minimumGeofenceRadiusMeters);
    const maximumRadius = Number(settings?.maximumGeofenceRadiusMeters);

    return {
      defaultRadius: Number.isFinite(defaultRadius) ? defaultRadius : 100,
      minimumRadius: Number.isFinite(minimumRadius) ? minimumRadius : 20,
      maximumRadius: Number.isFinite(maximumRadius) ? maximumRadius : 1000,
    };
  }

  /* ---------- Normalize coordinate value ---------- */
  static parseCoordinate(value) {
    if (value === undefined || value === null || String(value).trim() === "") {
      return null;
    }

    const numberValue = Number(value);

    return Number.isFinite(numberValue) ? numberValue : null;
  }

  /* ---------- Normalize geofence radius ---------- */
  static parseGeofenceRadius(value, defaultRadius = 100) {
    if (value === undefined || value === null || String(value).trim() === "") {
      return defaultRadius;
    }

    const radius = Number(value);

    return Number.isFinite(radius) ? radius : null;
  }

  /* ---------- Normalize branch payload ---------- */
  static async normalizeBranchPayload(body) {
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

    return {
      payload: {
        name: String(body.name || "").trim(),
        address: String(body.address || "").trim(),
        googlePlaceId: String(body.googlePlaceId || "").trim(),
        state: String(body.state || "").trim(),
        lga: String(body.lga || "").trim(),
        contactPhoneCode: String(body.contactPhoneCode || "+234").trim(),
        contactPhone: String(body.contactPhone || "").trim(),

        geofenceRadiusMeters,

        location: hasValidCoordinates
          ? {
              type: "Point",
              coordinates: [longitude, latitude],
            }
          : undefined,
      },

      geofencePolicy,
    };
  }

  /* ---------- Validate branch payload ---------- */
  static validateBranchPayload(payload, geofencePolicy) {
    if (!payload.name) {
      throw new Error("Branch name is required.");
    }

    if (!payload.address) {
      throw new Error("Branch address is required.");
    }

    if (!payload.state) {
      throw new Error("State is required.");
    }

    if (!payload.lga) {
      throw new Error("LGA is required.");
    }

    if (!payload.location || !Array.isArray(payload.location.coordinates)) {
      throw new Error("Please select a valid address from the address suggestions.");
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
      throw new Error("Branch coordinates are invalid.");
    }

    if (payload.geofenceRadiusMeters === null || !Number.isFinite(payload.geofenceRadiusMeters)) {
      throw new Error("Geofence radius must be a valid number.");
    }

    if (
      payload.geofenceRadiusMeters < geofencePolicy.minimumRadius ||
      payload.geofenceRadiusMeters > geofencePolicy.maximumRadius
    ) {
      throw new Error(
        `Geofence radius must be between ${geofencePolicy.minimumRadius} and ${geofencePolicy.maximumRadius} meters.`
      );
    }
  }

  /* ---------- Get all branches for business ---------- */
  static async getBranchesForBusiness(businessId) {
    return Branch.find({
      business: businessId,
    }).sort({ createdAt: -1 });
  }

  /* ---------- Get one branch for business ---------- */
  static async getBranchForBusiness({ branchId, businessId }) {
    const branch = await Branch.findOne({
      _id: branchId,
      business: businessId,
    });

    if (!branch) {
      throw new Error("Branch not found.");
    }

    return branch;
  }

  /* ---------- Create branch ---------- */
  static async createBranch({ businessId, body }) {
    const { payload, geofencePolicy } = await BranchService.normalizeBranchPayload(body);

    BranchService.validateBranchPayload(payload, geofencePolicy);

    const branch = new Branch({
      business: businessId,
      ...payload,
    });

    await branch.save();

    return branch;
  }

  /* ---------- Check whether a body field was submitted ---------- */
  static hasOwnField(body, fieldName) {
    return Object.prototype.hasOwnProperty.call(body || {}, fieldName);
  }

  /* ---------- Keep EmployerMember top-level role aligned ---------- */
  static syncMemberTopLevelRole(member) {
    const hasManagerBranch = member.branches.some(
      (assignment) => assignment.role === "branch_manager"
    );

    member.role = hasManagerBranch ? "branch_manager" : "branch_staff";
  }

  /* ---------- Assign or change branch manager ---------- */
  static async updateBranchManager({ branchId, businessId, managerMemberId }) {
    const selectedManagerId = String(managerMemberId || "").trim();

    await BranchService.getBranchForBusiness({
      branchId,
      businessId,
    });

    let newManager = null;

    /**
     * Validate the selected manager before changing the existing manager.
     *
     * This prevents a bad managerMemberId from demoting the current manager
     * before we discover that the new manager is invalid.
     */
    if (selectedManagerId) {
      newManager = await EmployerMember.findOne({
        _id: selectedManagerId,
        business: businessId,
        accountStatus: "active",
      });

      if (!newManager) {
        throw new Error("Selected manager was not found for this business.");
      }

      if (newManager.role === "admin") {
        throw new Error("Admins cannot be assigned to specific branches.");
      }
    }

    /**
     * Demote existing managers for this branch.
     *
     * We do not remove the branch assignment here.
     * We change branch_manager to branch_staff so the old manager stays
     * assigned to the branch but no longer manages it.
     */
    const existingManagers = await EmployerMember.find({
      business: businessId,
      accountStatus: "active",
      branches: {
        $elemMatch: {
          branch: branchId,
          role: "branch_manager",
        },
      },
    });

    for (const member of existingManagers) {
      if (selectedManagerId && member._id.toString() === selectedManagerId) {
        continue;
      }

      const assignment = member.branches.find(
        (item) => item.branch.toString() === branchId.toString()
      );

      if (assignment && assignment.role === "branch_manager") {
        assignment.role = "branch_staff";
      }

      BranchService.syncMemberTopLevelRole(member);

      await member.save();
    }

    /**
     * Empty managerMemberId means "Not assigned".
     * Existing manager has already been demoted to branch_staff.
     */
    if (!selectedManagerId) {
      return null;
    }

    const existingAssignment = newManager.branches.find(
      (item) => item.branch.toString() === branchId.toString()
    );

    if (existingAssignment) {
      existingAssignment.role = "branch_manager";
      existingAssignment.assignedAt = existingAssignment.assignedAt || new Date();
    } else {
      newManager.branches.push({
        branch: branchId,
        role: "branch_manager",
        assignedAt: new Date(),
      });
    }

    newManager.role = "branch_manager";

    await newManager.save();

    return newManager;
  }

  /* ---------- Update branch ---------- */
  static async updateBranch({ branchId, businessId, body }) {
    if (!branchId) {
      throw new Error("Branch ID is required.");
    }

    const branch = await BranchService.getBranchForBusiness({
      branchId,
      businessId,
    });

    const { payload, geofencePolicy } = await BranchService.normalizeBranchPayload(body);

    BranchService.validateBranchPayload(payload, geofencePolicy);

    branch.name = payload.name;
    branch.address = payload.address;
    branch.googlePlaceId = payload.googlePlaceId;
    branch.state = payload.state;
    branch.lga = payload.lga;
    branch.contactPhoneCode = payload.contactPhoneCode;
    branch.contactPhone = payload.contactPhone;
    branch.location = payload.location;
    branch.geofenceRadiusMeters = payload.geofenceRadiusMeters;

    await branch.save();

    if (BranchService.hasOwnField(body, "managerMemberId")) {
      await BranchService.updateBranchManager({
        branchId,
        businessId,
        managerMemberId: body.managerMemberId,
      });
    }

    return branch;
  }

  /* ---------- Get branch members ---------- */
  static async getBranchMembers({ branchId, businessId }) {
    await BranchService.getBranchForBusiness({
      branchId,
      businessId,
    });

    return EmployerMember.find({
      business: businessId,
      "branches.branch": branchId,
    })
      .populate("user", "firstName lastName email displayName")
      .sort({ createdAt: -1 });
  }
}

module.exports = BranchService;
