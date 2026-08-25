// services/branchService.js

const Branch = require("../models/Branch");
const EmployerMember = require("../models/EmployerMember");
const PlatformSettings = require("../models/PlatformSettings");

class BranchService {
  /* ---------- Get active platform settings ---------- */
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

  /* ---------- Get geofence policy from platform settings ---------- */
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

  /* ---------- Parse coordinate value ---------- */
  static parseCoordinate(value) {
    if (value === undefined || value === null || String(value).trim() === "") {
      return null;
    }

    const numberValue = Number(value);

    return Number.isFinite(numberValue) ? numberValue : null;
  }

  /* ---------- Parse geofence radius ---------- */
  static parseGeofenceRadius(value, defaultRadius = 100) {
    if (value === undefined || value === null || String(value).trim() === "") {
      return defaultRadius;
    }

    const radius = Number(value);

    return Number.isFinite(radius) ? radius : null;
  }

  /* ---------- Normalize branch payload ---------- */
  static async normalizeBranchPayload(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Branch details are required.");
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

    /*
     * Do not store a phone code when no phone number was submitted.
     *
     * This also protects against the form submitting its selected default
     * phone code while the optional phone-number field is empty.
     */
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

    if (
      payload.geofenceRadiusMeters === null ||
      !Number.isSafeInteger(payload.geofenceRadiusMeters)
    ) {
      throw new Error("Geofence radius must be a whole number.");
    }

    if (
      payload.geofenceRadiusMeters < geofencePolicy.minimumRadius ||
      payload.geofenceRadiusMeters > geofencePolicy.maximumRadius
    ) {
      throw new Error(
        `Geofence radius must be between ${geofencePolicy.minimumRadius} and ${geofencePolicy.maximumRadius} meters.`
      );
    }

    if (payload.contactPhone && !payload.contactPhoneCode) {
      throw new Error("Contact phone code is required when a contact phone number is provided.");
    }

    if (payload.contactPhoneCode && !/^\+\d{1,4}$/.test(payload.contactPhoneCode)) {
      throw new Error("Contact phone code must be a valid international dialing code.");
    }

    if (payload.contactPhoneCode && !payload.contactPhone) {
      throw new Error("Contact phone number is required when a contact phone code is provided.");
    }
  }

  /* ---------- Get all branches for business ---------- */
  static async getBranchesForBusiness(businessId) {
    return Branch.find({
      business: businessId,
    }).sort({
      createdAt: -1,
    });
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
    if (!businessId) {
      throw new Error("Business ID is required.");
    }

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

    /*
     * Validate the selected manager before changing the existing manager.
     *
     * This prevents an invalid managerMemberId from demoting the existing
     * branch manager before the selected replacement is validated.
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

    /*
     * Demote existing managers for this branch.
     *
     * The existing branch assignment is retained. Only its role changes
     * from branch_manager to branch_staff.
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

    /*
     * An empty managerMemberId means "Not assigned".
     * Any existing manager has already been changed to branch_staff.
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

    if (!businessId) {
      throw new Error("Business ID is required.");
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
      .sort({
        createdAt: -1,
      });
  }
}

module.exports = BranchService;
