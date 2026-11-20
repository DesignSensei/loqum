// services/facilityPermitVerificationService.js

const mongoose = require("mongoose");

const EmployerProfile = require("../models/EmployerProfile");
const EmployerMember = require("../models/EmployerMember");
const Branch = require("../models/Branch");
const FacilityPermit = require("../models/FacilityPermit");
const User = require("../models/User");

const { runWithOptionalTransaction } = require("./helpers/transactionHelper");

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const MIME_EXTENSIONS = Object.freeze({
  "application/pdf": ["pdf"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
});

const VALIDITY_TYPES = ["expiry_date", "licensing_year", "indefinite"];

const SCOPES = ["facility", "service", "equipment"];

const REQUIREMENT_KEY = /^[a-z][a-z0-9_:-]*$/;
const AUTHORITY_CODE = /^[a-z][a-z0-9_]*$/;

class FacilityPermitVerificationService {
  // ───────────────────── ERRORS AND INPUT VALIDATION ─────────────────────

  static error(message, code, statusCode = 400) {
    const error = new Error(message);
    error.name = "FacilityPermitVerificationServiceError";
    error.code = code;
    error.statusCode = statusCode;
    return error;
  }

  static assertId(value, name) {
    if (!mongoose.isValidObjectId(value)) {
      throw this.error(`Invalid ${name}.`, "FACILITY_PERMIT_INVALID_ID");
    }
  }

  static text(value, maximum, label, required = true) {
    if (typeof value !== "string") {
      if (!required && (value === undefined || value === null)) {
        return null;
      }

      throw this.error(`${label} must be text.`, "FACILITY_PERMIT_INVALID_INPUT");
    }

    if (/[\u0000-\u001F\u007F]/.test(value)) {
      throw this.error(`${label} contains invalid characters.`, "FACILITY_PERMIT_INVALID_INPUT");
    }

    const clean = value.normalize("NFC").trim().replace(/\s+/g, " ");

    if ((required && !clean) || clean.length > maximum) {
      throw this.error(`${label} is missing or too long.`, "FACILITY_PERMIT_INVALID_INPUT");
    }

    return clean || null;
  }

  // ───────────────────── DATES AND VALIDITY ─────────────────────

  static nigeriaDate(now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Lagos",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);

    const get = (type) => parts.find((part) => part.type === type)?.value;

    return `${get("year")}-${get("month")}-${get("day")}`;
  }

  static validDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }

    const parsed = new Date(`${value}T00:00:00.000Z`);

    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  static isInForce(permit, today = this.nigeriaDate()) {
    return (
      permit.status === "verified" &&
      !permit.revokedAt &&
      this.validDate(permit.validFromDate) &&
      permit.validFromDate <= today &&
      (permit.validityType === "indefinite" ||
        (this.validDate(permit.expiryDate) && permit.expiryDate >= today))
    );
  }

  // ───────────────────── PHYSICAL PREMISES ─────────────────────

  static samePremises(branch, snapshot) {
    const oldCoordinates = snapshot?.location?.coordinates;
    const newCoordinates = branch?.location?.coordinates;

    return Boolean(
      snapshot &&
      branch.address === snapshot.address &&
      branch.state === snapshot.state &&
      branch.lga === snapshot.lga &&
      branch.googlePlaceId === snapshot.googlePlaceId &&
      Array.isArray(oldCoordinates) &&
      oldCoordinates.length === 2 &&
      Array.isArray(newCoordinates) &&
      newCoordinates.length === 2 &&
      Number(oldCoordinates[0]) === Number(newCoordinates[0]) &&
      Number(oldCoordinates[1]) === Number(newCoordinates[1])
    );
  }

  static snapshot(branch) {
    return {
      address: branch.address,
      state: branch.state,
      lga: branch.lga,
      googlePlaceId: branch.googlePlaceId,
      location: {
        type: "Point",
        coordinates: [...branch.location.coordinates],
      },
    };
  }

  // ───────────────────── REQUIREMENT POLICY ─────────────────────

  /**
   * Requirements are server-controlled and deployment-reviewed.
   * Do not invent default Nigerian regulatory requirements.
   *
   * FACILITY_PERMIT_POLICY_JSON remains the source of truth.
   */
  static getRequirementsForBranch({ business, branch }) {
    let parsed;

    try {
      parsed = JSON.parse(process.env.FACILITY_PERMIT_POLICY_JSON || "null");
    } catch {
      throw this.error(
        "Facility permit policy configuration is invalid.",
        "FACILITY_PERMIT_POLICY_INVALID",
        503
      );
    }

    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.rules)) {
      throw this.error(
        "Facility permit requirements have not been configured.",
        "FACILITY_PERMIT_POLICY_UNCONFIGURED",
        503
      );
    }

    const type = String(business.type || "").toLowerCase();

    const state = String(branch.state || "")
      .trim()
      .toLowerCase();

    const rules = parsed.rules.filter(
      (rule) =>
        rule &&
        rule.type === type &&
        typeof rule.state === "string" &&
        rule.state.toLowerCase() === state
    );

    const fallback = parsed.rules.filter(
      (rule) => rule && rule.type === type && rule.state === "*"
    );

    const selected = rules.length ? rules : fallback;

    if (
      selected.length !== 1 ||
      !Array.isArray(selected[0].requirements) ||
      selected[0].requirements.length === 0
    ) {
      throw this.error(
        "No unambiguous facility permit rule exists for this branch.",
        "FACILITY_PERMIT_POLICY_MISSING_RULE",
        503
      );
    }

    const seen = new Set();

    return selected[0].requirements.map((item) => {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.requirementKey !== "string" ||
        !REQUIREMENT_KEY.test(item.requirementKey) ||
        item.requirementKey.length > 120 ||
        seen.has(item.requirementKey) ||
        typeof item.authorityCode !== "string" ||
        !AUTHORITY_CODE.test(item.authorityCode) ||
        item.authorityCode.length > 80 ||
        typeof item.authorityName !== "string" ||
        !item.authorityName.trim() ||
        item.authorityName.length > 200 ||
        !SCOPES.includes(item.scope) ||
        !Array.isArray(item.validityTypes) ||
        item.validityTypes.length === 0 ||
        item.validityTypes.some((value) => !VALIDITY_TYPES.includes(value))
      ) {
        throw this.error(
          "Facility permit requirement configuration is invalid.",
          "FACILITY_PERMIT_POLICY_INVALID",
          503
        );
      }

      seen.add(item.requirementKey);

      return {
        requirementKey: item.requirementKey,
        authorityCode: item.authorityCode,
        authorityName: item.authorityName.trim(),
        scope: item.scope,
        validityTypes: [...new Set(item.validityTypes)],
      };
    });
  }

  // ───────────────────── AUTHORIZATION ─────────────────────

  static async assertEmployerManager({ businessId, actorUserId, session = null }) {
    this.assertId(businessId, "employer business ID");
    this.assertId(actorUserId, "employer user ID");

    const business = await EmployerProfile.findById(businessId).session(session);

    const user = await User.findOne({
      _id: actorUserId,
      role: "employer",
      accountStatus: "active",
      isVerified: true,
    })
      .select("_id")
      .session(session);

    if (!business || business.accountStatus !== "active" || !user) {
      throw this.error(
        "An active employer account is required.",
        "FACILITY_PERMIT_EMPLOYER_INELIGIBLE",
        403
      );
    }

    if (String(business.user) === String(actorUserId)) {
      return business;
    }

    const member = await EmployerMember.exists({
      business: business._id,
      user: actorUserId,
      role: "admin",
      accountStatus: "active",
      isCurrent: true,
    }).session(session);

    if (!member) {
      throw this.error(
        "Only the owner or an active business administrator may manage permits.",
        "FACILITY_PERMIT_FORBIDDEN",
        403
      );
    }

    return business;
  }

  static async assertAdmin(adminUserId, session = null) {
    this.assertId(adminUserId, "administrator user ID");

    const user = await User.findOne({
      _id: adminUserId,
      role: "admin",
      accountStatus: "active",
      isVerified: true,
    })
      .select("_id")
      .session(session);

    if (!user) {
      throw this.error(
        "An active administrator is required.",
        "FACILITY_PERMIT_ADMIN_REQUIRED",
        403
      );
    }

    return user;
  }

  static async getOwnedBranch({ businessId, branchId, session = null }) {
    this.assertId(businessId, "business ID");
    this.assertId(branchId, "branch ID");

    const branch = await Branch.findOne({
      _id: branchId,
      business: businessId,
    }).session(session);

    if (!branch) {
      throw this.error(
        "Branch not found for this employer.",
        "FACILITY_PERMIT_BRANCH_NOT_FOUND",
        404
      );
    }

    return branch;
  }

  // ───────────────────── BRANCH WRITE FENCE ─────────────────────

  /**
   * Serializes permit submissions, reviews, revocations,
   * due-date activation and branch relocation.
   *
   * Incrementing __v guarantees a write even when two transactions
   * have identical timestamps. This is retained for real writes.
   */
  static async fenceBranch({ businessId, branchId, session }) {
    if (!session || typeof session.inTransaction !== "function" || !session.inTransaction()) {
      throw this.error(
        "An active transaction is required for branch fencing.",
        "FACILITY_PERMIT_TRANSACTION_REQUIRED",
        500
      );
    }

    const branch = await Branch.findOneAndUpdate(
      {
        _id: branchId,
        business: businessId,
      },
      {
        $inc: {
          __v: 1,
        },
        $currentDate: {
          updatedAt: true,
        },
      },
      {
        session,
        new: true,
        timestamps: false,
      }
    );

    if (!branch) {
      throw this.error("The branch is no longer available.", "FACILITY_PERMIT_BRANCH_CHANGED", 409);
    }

    return branch;
  }

  // ───────────────────── TRUSTED PRIVATE UPLOAD ─────────────────────

  /**
   * Upload evidence must originate from trusted authenticated
   * multipart middleware, not client-supplied URLs.
   *
   * Expected upload:
   * {
   *   category: "facility_permit",
   *   ownerId: branchId,
   *   fileUrl,
   *   mimeType,
   *   sizeBytes
   * }
   */
  static validateTrustedUpload(upload, branchId) {
    if (
      !upload ||
      typeof upload !== "object" ||
      Array.isArray(upload) ||
      upload.category !== "facility_permit" ||
      String(upload.ownerId || "") !== String(branchId) ||
      typeof upload.fileUrl !== "string" ||
      typeof upload.mimeType !== "string" ||
      !Object.hasOwn(MIME_EXTENSIONS, upload.mimeType) ||
      !Number.isSafeInteger(upload.sizeBytes) ||
      upload.sizeBytes <= 0 ||
      upload.sizeBytes > MAX_DOCUMENT_BYTES
    ) {
      throw this.error(
        "A validated private facility permit upload is required.",
        "FACILITY_PERMIT_TRUSTED_UPLOAD_REQUIRED"
      );
    }

    const escapedId = String(branchId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const pattern = new RegExp(
      `^private://facility_permit/${escapedId}/([a-f0-9]{32,64}|[a-f0-9-]{36})\\.(pdf|jpg|jpeg|png|webp)$`,
      "i"
    );

    const match = pattern.exec(upload.fileUrl);

    if (!match || !MIME_EXTENSIONS[upload.mimeType].includes(match[2].toLowerCase())) {
      throw this.error(
        "Private document reference does not match this branch.",
        "FACILITY_PERMIT_INVALID_DOCUMENT_REFERENCE"
      );
    }

    return {
      documentRef: upload.fileUrl,
      documentMimeType: upload.mimeType,
      documentSizeBytes: upload.sizeBytes,
    };
  }

  // ───────────────────── APPROVED VALIDITY ─────────────────────

  static validateValidity(validity, requirement, today) {
    if (
      !validity ||
      typeof validity !== "object" ||
      Array.isArray(validity) ||
      !requirement.validityTypes.includes(validity.validityType)
    ) {
      throw this.error(
        "The approved validity type is not permitted for this requirement.",
        "FACILITY_PERMIT_INVALID_VALIDITY"
      );
    }

    const type = validity.validityType;
    const start = validity.validFromDate;

    if (!this.validDate(start)) {
      throw this.error(
        "An approved YYYY-MM-DD validity start date is required.",
        "FACILITY_PERMIT_INVALID_VALIDITY"
      );
    }

    let expiryDate = null;
    let licensingYear = null;

    if (type === "expiry_date") {
      if (!this.validDate(validity.expiryDate)) {
        throw this.error(
          "A verified YYYY-MM-DD expiry date is required.",
          "FACILITY_PERMIT_INVALID_VALIDITY"
        );
      }

      expiryDate = validity.expiryDate;
    } else if (type === "licensing_year") {
      if (
        !Number.isSafeInteger(validity.licensingYear) ||
        validity.licensingYear < 1900 ||
        validity.licensingYear > 2199
      ) {
        throw this.error(
          "A verified licensing year is required.",
          "FACILITY_PERMIT_INVALID_VALIDITY"
        );
      }

      // Only for officially verified calendar-year licensing rules.
      licensingYear = validity.licensingYear;
      expiryDate = `${licensingYear}-12-31`;
    }

    if (expiryDate && (expiryDate < start || expiryDate < today)) {
      throw this.error(
        "An expired or chronologically invalid permit cannot be approved.",
        "FACILITY_PERMIT_EXPIRED"
      );
    }

    return {
      validityType: type,
      validFromDate: start,
      expiryDate,
      licensingYear,
    };
  }

  // ───────────────────── EMPLOYER PERMIT SUBMISSION ─────────────────────

  static async submitPermit({ businessId, branchId, actorUserId, submission, permitUpload }) {
    this.assertId(businessId, "business ID");
    this.assertId(branchId, "branch ID");
    this.assertId(actorUserId, "employer user ID");

    if (!submission || typeof submission !== "object" || Array.isArray(submission)) {
      throw this.error("Facility permit details are required.", "FACILITY_PERMIT_INVALID_INPUT");
    }

    const document = this.validateTrustedUpload(permitUpload, branchId);

    const requirementKey = this.text(submission.requirementKey, 120, "Permit requirement");

    const permitNumber = this.text(submission.permitNumber, 120, "Permit number");

    const permitDescription = this.text(
      submission.permitDescription,
      300,
      "Permit description",
      false
    );

    const session = await mongoose.startSession();

    try {
      let saved;

      await session.withTransaction(async () => {
        const business = await this.assertEmployerManager({
          businessId,
          actorUserId,
          session,
        });

        const branch = await this.fenceBranch({
          businessId,
          branchId,
          session,
        });

        const requirement = this.getRequirementsForBranch({
          business,
          branch,
        }).find((entry) => entry.requirementKey === requirementKey);

        if (!requirement) {
          throw this.error(
            "This permit requirement is not configured for the branch.",
            "FACILITY_PERMIT_REQUIREMENT_NOT_APPLICABLE"
          );
        }

        // One open pending submission per requirement.
        const outstanding = await FacilityPermit.exists({
          business: business._id,
          branch: branch._id,
          requirementKey,
          status: "pending",
        }).session(session);

        if (outstanding) {
          throw this.error(
            "This branch already has a pending submission for that permit.",
            "FACILITY_PERMIT_PENDING_EXISTS",
            409
          );
        }

        // Do not silently overwrite future-approved permits.
        const futureApproved = await FacilityPermit.exists({
          business: business._id,
          branch: branch._id,
          requirementKey,
          status: "verified",
          isCurrent: false,
          revokedAt: null,
          activatedAt: null,
          validFromDate: {
            $gt: this.nigeriaDate(),
          },
        }).session(session);

        if (futureApproved) {
          throw this.error(
            "A future-approved permit is already scheduled for this requirement.",
            "FACILITY_PERMIT_FUTURE_APPROVAL_EXISTS",
            409
          );
        }

        const current = await FacilityPermit.findOne({
          business: business._id,
          branch: branch._id,
          requirementKey,
          isCurrent: true,
        }).session(session);

        const preceding =
          current ||
          (await FacilityPermit.findOne({
            business: business._id,
            branch: branch._id,
            requirementKey,
            status: "verified",
          })
            .sort({
              createdAt: -1,
              _id: -1,
            })
            .session(session));

        const records = await FacilityPermit.create(
          [
            {
              business: business._id,
              branch: branch._id,
              requirementKey,
              scope: requirement.scope,
              authorityCode: requirement.authorityCode,
              authorityName: requirement.authorityName,
              permitNumber,
              permitDescription,
              branchLocationSnapshot: this.snapshot(branch),
              ...document,
              submittedBy: actorUserId,
              status: "pending",
              isCurrent: false,
              renewalOf: preceding?._id || null,
            },
          ],
          { session }
        );

        saved = records[0];
      });

      return {
        permitId: saved._id,
        branchId: saved.branch,
        status: saved.status,
        requirementKey: saved.requirementKey,
        submittedAt: saved.submittedAt,
      };
    } finally {
      await session.endSession();
    }
  }

  // ───────────────────── ADMIN PERMIT REVIEW ─────────────────────

  static async reviewPermit({
    businessId,
    branchId,
    permitId,
    adminUserId,
    decision,
    note,
    validity = null,
  }) {
    this.assertId(businessId, "business ID");
    this.assertId(branchId, "branch ID");
    this.assertId(permitId, "permit ID");

    await this.assertAdmin(adminUserId);

    const status = String(decision || "")
      .trim()
      .toLowerCase();

    if (!["verified", "needs_review", "rejected"].includes(status)) {
      throw this.error(
        "Invalid facility permit review decision.",
        "FACILITY_PERMIT_INVALID_DECISION"
      );
    }

    const reviewNote = this.text(note, 1000, "Administrative review note");

    if (status === "verified" && reviewNote.length < 20) {
      throw this.error(
        "Document the checks performed before approving a permit.",
        "FACILITY_PERMIT_REVIEW_NOTE_REQUIRED"
      );
    }

    const session = await mongoose.startSession();

    try {
      let reviewed;

      await session.withTransaction(async () => {
        await this.assertAdmin(adminUserId, session);

        const branch = await this.fenceBranch({
          businessId,
          branchId,
          session,
        });

        const business = await EmployerProfile.findById(businessId).session(session);

        if (!business) {
          throw this.error(
            "Employer business not found.",
            "FACILITY_PERMIT_BUSINESS_NOT_FOUND",
            404
          );
        }

        const permit = await FacilityPermit.findOne({
          _id: permitId,
          business: businessId,
          branch: branchId,
        }).session(session);

        if (!permit) {
          throw this.error("Facility permit not found.", "FACILITY_PERMIT_NOT_FOUND", 404);
        }

        if (!["pending", "needs_review"].includes(permit.status)) {
          throw this.error(
            "This submission has already received its final decision.",
            "FACILITY_PERMIT_REVIEW_ALREADY_FINAL",
            409
          );
        }

        // Prevent review of superseded submissions.
        const newest = await FacilityPermit.findOne({
          business: businessId,
          branch: branchId,
          requirementKey: permit.requirementKey,
          status: {
            $in: ["pending", "needs_review"],
          },
        })
          .sort({
            createdAt: -1,
            _id: -1,
          })
          .session(session);

        if (!newest || String(newest._id) !== String(permit._id)) {
          throw this.error(
            "This submission has been superseded by a newer document.",
            "FACILITY_PERMIT_SUPERSEDED",
            409
          );
        }

        const now = new Date();

        permit.status = status;
        permit.reviewedBy = adminUserId;
        permit.reviewedAt = now;
        permit.reviewNote = reviewNote;
        permit.rejectionReason = status === "rejected" ? reviewNote.slice(0, 500) : null;
        permit.verifiedAt = null;

        if (status === "verified") {
          const requirement = this.getRequirementsForBranch({
            business,
            branch,
          }).find((item) => item.requirementKey === permit.requirementKey);

          if (
            !requirement ||
            requirement.authorityCode !== permit.authorityCode ||
            requirement.scope !== permit.scope ||
            !this.samePremises(branch, permit.branchLocationSnapshot)
          ) {
            throw this.error(
              "Permit requirement, authority or premises changed since submission.",
              "FACILITY_PERMIT_CONTEXT_CHANGED",
              409
            );
          }

          const approvedValidity = this.validateValidity(validity, requirement, this.nigeriaDate());

          permit.set(approvedValidity);
          permit.verifiedAt = now;

          if (approvedValidity.validFromDate <= this.nigeriaDate()) {
            const prior = await FacilityPermit.find({
              business: businessId,
              branch: branchId,
              requirementKey: permit.requirementKey,
              isCurrent: true,
              _id: {
                $ne: permit._id,
              },
            }).session(session);

            for (const oldPermit of prior) {
              oldPermit.isCurrent = false;
              oldPermit.deactivatedAt = now;
              await oldPermit.save({ session });
            }

            permit.isCurrent = true;
            permit.activatedAt = now;
            permit.deactivatedAt = null;
          } else {
            // Future renewals do not replace current permits early.
            permit.isCurrent = false;
            permit.activatedAt = null;
          }
        }

        await permit.save({ session });
        reviewed = permit;
      });

      return {
        permitId: reviewed._id,
        branchId: reviewed.branch,
        status: reviewed.status,
        isCurrent: reviewed.isCurrent,
        validFromDate: reviewed.validFromDate,
        expiryDate: reviewed.expiryDate,
        validityType: reviewed.validityType,
        reviewedAt: reviewed.reviewedAt,
      };
    } finally {
      await session.endSession();
    }
  }

  // ───────────────────── ADMIN REVOCATION ─────────────────────

  static async revokePermit({ businessId, branchId, permitId, adminUserId, reason }) {
    this.assertId(businessId, "business ID");
    this.assertId(branchId, "branch ID");
    this.assertId(permitId, "permit ID");

    const reviewReason = this.text(reason, 500, "Revocation reason");

    if (reviewReason.length < 15) {
      throw this.error(
        "A meaningful revocation reason is required.",
        "FACILITY_PERMIT_REVOCATION_REASON_REQUIRED"
      );
    }

    await this.assertAdmin(adminUserId);

    const session = await mongoose.startSession();

    try {
      let saved;

      await session.withTransaction(async () => {
        await this.assertAdmin(adminUserId, session);

        await this.fenceBranch({
          businessId,
          branchId,
          session,
        });

        const permit = await FacilityPermit.findOne({
          _id: permitId,
          business: businessId,
          branch: branchId,
        }).session(session);

        if (!permit) {
          throw this.error("Facility permit not found.", "FACILITY_PERMIT_NOT_FOUND", 404);
        }

        if (permit.status !== "verified" || permit.revokedAt) {
          throw this.error(
            "Only an unrevoked verified permit may be revoked.",
            "FACILITY_PERMIT_REVOCATION_CONFLICT",
            409
          );
        }

        const now = new Date();

        if (permit.isCurrent) {
          permit.isCurrent = false;
          permit.deactivatedAt = now;
        }

        permit.revokedAt = now;
        permit.revokedBy = adminUserId;
        permit.revocationReason = reviewReason;

        await permit.save({ session });

        saved = permit;
      });

      return {
        permitId: saved._id,
        branchId: saved.branch,
        status: saved.status,
        revokedAt: saved.revokedAt,
        isCurrent: false,
      };
    } finally {
      await session.endSession();
    }
  }

  // ───────────────────── DUE-RENEWAL DISCOVERY ─────────────────────

  /**
   * This is an indexed candidate filter, not a verification decision.
   *
   * Only verified, non-current, never-activated, non-revoked
   * permits that have started and have not expired are candidates.
   *
   * Requirement policy, physical premises, and validity are checked
   * again inside the activation transaction.
   */
  static duePermitFilter({ businessId, branchIds, today }) {
    return {
      business: businessId,
      ...(branchIds ? { branch: { $in: branchIds } } : {}),
      status: "verified",
      isCurrent: false,
      activatedAt: null,
      revokedAt: null,
      validFromDate: {
        $lte: today,
      },
      $or: [
        {
          validityType: "indefinite",
        },
        {
          expiryDate: {
            $gte: today,
          },
        },
      ],
    };
  }

  static normalizeBranchIds(branchIds) {
    if (!Array.isArray(branchIds)) {
      throw this.error("Branch IDs must be an array.", "FACILITY_PERMIT_INVALID_ID");
    }

    const distinct = new Map();

    for (const branchId of branchIds) {
      this.assertId(branchId, "branch ID");
      distinct.set(String(branchId), branchId);
    }

    return [...distinct.values()];
  }

  /**
   * A single, read-only query identifies branches with
   * potentially due permits.
   *
   * Return values are branch IDs, not approved eligibility decisions.
   * This can be called from shiftQueryService or a future scheduler.
   */
  static async getBranchesWithDuePermits({ businessId, branchIds = [], session = null }) {
    this.assertId(businessId, "business ID");

    const ids = this.normalizeBranchIds(branchIds);

    if (!ids.length) {
      return [];
    }

    const due = await FacilityPermit.distinct(
      "branch",
      this.duePermitFilter({
        businessId,
        branchIds: ids,
        today: this.nigeriaDate(),
      })
    ).session(session);

    return due.map(String);
  }

  // ───────────────────── GLOBAL DUE-RENEWAL DISCOVERY ─────────────────────

  /**
   * Read-only, bounded discovery across all employer businesses.
   *
   * Uses a stable keyset cursor rather than skip-based pagination.
   * This avoids repeatedly scanning the first page when some
   * renewal candidates remain ineligible.
   *
   * Discovery does not grant eligibility or change permit records.
   * activateDuePermits() performs the authoritative checks.
   */
  static async getDuePermitActivationTargets({ limit = 100, cursor = null } = {}) {
    const normalizedLimit = Number(limit);

    if (!Number.isSafeInteger(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > 1000) {
      throw this.error(
        "Due-permit discovery limit must be between 1 and 1000.",
        "FACILITY_PERMIT_INVALID_DISCOVERY_LIMIT"
      );
    }

    const today = this.nigeriaDate();

    const filter = {
      status: "verified",
      isCurrent: false,
      activatedAt: null,
      revokedAt: null,
      validFromDate: {
        $lte: today,
      },
      $or: [
        {
          validityType: "indefinite",
        },
        {
          expiryDate: {
            $gte: today,
          },
        },
      ],
    };

    if (cursor !== null) {
      if (
        !cursor ||
        !this.validDate(cursor.validFromDate) ||
        !mongoose.isValidObjectId(cursor.id)
      ) {
        throw this.error(
          "Invalid due-permit discovery cursor.",
          "FACILITY_PERMIT_INVALID_DISCOVERY_CURSOR"
        );
      }

      const lastId = new mongoose.Types.ObjectId(String(cursor.id));

      filter.$and = [
        {
          $or: [
            {
              validFromDate: {
                $gt: cursor.validFromDate,
              },
            },
            {
              validFromDate: cursor.validFromDate,
              _id: {
                $gt: lastId,
              },
            },
          ],
        },
      ];
    }

    const permits = await FacilityPermit.find(filter)
      .select("_id business branch validFromDate")
      .sort({
        validFromDate: 1,
        _id: 1,
      })
      .limit(normalizedLimit)
      .lean();

    const last = permits[permits.length - 1];

    return {
      targets: permits.map((permit) => ({
        permitId: String(permit._id),
        businessId: String(permit.business),
        branchId: String(permit.branch),
        validFromDate: permit.validFromDate,
      })),

      nextCursor: last
        ? {
            validFromDate: last.validFromDate,
            id: String(last._id),
          }
        : null,

      hasMore: permits.length === normalizedLimit,
    };
  }

  // ───────────────────── TRANSACTIONAL RENEWAL ACTIVATION ─────────────────────

  /**
   * With a caller-provided transaction:
   *   - Do not precheck outside that transaction.
   *   - Always preserve the branch write fence.
   *   - Recheck policy, premises, and validity before writes.
   *
   * Without a supplied transaction:
   *   - Check for due candidates first.
   *   - Skip the transaction entirely when no renewal is due.
   *   - Preserve business, branch, and policy validation.
   */
  static async activateDuePermits({ businessId, branchId, session = null }) {
    this.assertId(businessId, "business ID");
    this.assertId(branchId, "branch ID");

    if (!session) {
      const due = await FacilityPermit.exists(
        this.duePermitFilter({
          businessId,
          branchIds: [branchId],
          today: this.nigeriaDate(),
        })
      );

      if (!due) {
        // Read-only fast path: no session, transaction or branch write.
        const branch = await this.getOwnedBranch({
          businessId,
          branchId,
        });

        const business = await EmployerProfile.findById(businessId);

        if (!business) {
          throw this.error(
            "Employer business not found.",
            "FACILITY_PERMIT_BUSINESS_NOT_FOUND",
            404
          );
        }

        this.getRequirementsForBranch({
          business,
          branch,
        });

        return {
          activatedPermitIds: [],
        };
      }
    }

    return runWithOptionalTransaction({ session }, async (transactionSession) => {
      // Results remain local to this transaction attempt.
      const activated = [];

      const branch = await this.fenceBranch({
        businessId,
        branchId,
        session: transactionSession,
      });

      const business = await EmployerProfile.findById(businessId).session(transactionSession);

      if (!business) {
        throw this.error("Employer business not found.", "FACILITY_PERMIT_BUSINESS_NOT_FOUND", 404);
      }

      const requirements = this.getRequirementsForBranch({
        business,
        branch,
      });

      const today = this.nigeriaDate();
      const now = new Date();

      // Re-read candidates inside the transaction.
      const due = await FacilityPermit.find(
        this.duePermitFilter({
          businessId,
          branchIds: [branchId],
          today,
        })
      )
        .sort({
          validFromDate: -1,
          reviewedAt: -1,
          _id: -1,
        })
        .session(transactionSession);

      for (const requirement of requirements) {
        const candidate = due.find(
          (item) =>
            item.requirementKey === requirement.requirementKey &&
            item.authorityCode === requirement.authorityCode &&
            item.scope === requirement.scope &&
            requirement.validityTypes.includes(item.validityType) &&
            this.samePremises(branch, item.branchLocationSnapshot) &&
            this.isInForce(item, today)
        );

        if (!candidate) {
          continue;
        }

        const previous = await FacilityPermit.find({
          business: businessId,
          branch: branchId,
          requirementKey: requirement.requirementKey,
          isCurrent: true,
        }).session(transactionSession);

        // Document saves preserve the model's validation safeguards.
        for (const oldPermit of previous) {
          oldPermit.isCurrent = false;
          oldPermit.deactivatedAt = now;

          await oldPermit.save({
            session: transactionSession,
          });
        }

        candidate.isCurrent = true;
        candidate.activatedAt = now;
        candidate.deactivatedAt = null;

        await candidate.save({
          session: transactionSession,
        });

        activated.push(String(candidate._id));
      }

      return {
        activatedPermitIds: activated,
      };
    });
  }

  // ───────────────────── BATCHED BRANCH READINESS ─────────────────────

  /**
   * Evaluate multiple branches with shared database reads:
   *
   * - One employer read.
   * - One branch query.
   * - One owner read.
   * - One current-permits query.
   *
   * Session operations are sequential, including when called
   * inside a marketplace transaction.
   *
   * This method does not perform activation or database writes.
   */
  static async getBranchesReadiness({ businessId, branchIds = [], session = null }) {
    this.assertId(businessId, "business ID");

    const ids = this.normalizeBranchIds(branchIds);

    const result = new Map();

    if (!ids.length) {
      return result;
    }

    const business = await EmployerProfile.findById(businessId).session(session);

    const branches = await Branch.find({
      business: businessId,
      _id: {
        $in: ids,
      },
    })
      .session(session)
      .lean();

    if (!business || branches.length !== ids.length) {
      throw this.error("Employer branch not found.", "FACILITY_PERMIT_BRANCH_NOT_FOUND", 404);
    }

    const owner = await User.findOne({
      _id: business.user,
      role: "employer",
      accountStatus: "active",
      isVerified: true,
    })
      .select("_id")
      .session(session)
      .lean();

    const permits = await FacilityPermit.find({
      business: businessId,
      branch: {
        $in: ids,
      },
      isCurrent: true,
    })
      .select(
        "branch requirementKey authorityCode scope " +
          "validityType validFromDate expiryDate " +
          "status revokedAt branchLocationSnapshot"
      )
      .session(session)
      .lean();

    const branchesById = new Map(branches.map((branch) => [String(branch._id), branch]));

    const permitsByBranchId = new Map();

    for (const permit of permits) {
      const key = String(permit.branch);

      if (!permitsByBranchId.has(key)) {
        permitsByBranchId.set(key, []);
      }

      permitsByBranchId.get(key).push(permit);
    }

    const today = this.nigeriaDate();

    for (const id of ids) {
      const key = String(id);
      const branch = branchesById.get(key);

      const identityReady = Boolean(
        owner &&
        business.cacVerificationStatus === "verified" &&
        business.accountStatus === "active" &&
        branch.isActive === true
      );

      let requirements;

      try {
        requirements = this.getRequirementsForBranch({
          business,
          branch,
        });
      } catch (error) {
        if (!String(error.code || "").startsWith("FACILITY_PERMIT_POLICY_")) {
          throw error;
        }

        result.set(key, {
          canPost: false,
          identityReady,
          branchActive: branch.isActive === true,
          requirements: [],
          missingRequirementKeys: [],
          reason: error.code,
        });

        continue;
      }

      const current = permitsByBranchId.get(key) || [];

      const satisfied = [];
      const missing = [];

      for (const requirement of requirements) {
        const matching = current.find(
          (permit) =>
            permit.requirementKey === requirement.requirementKey &&
            permit.authorityCode === requirement.authorityCode &&
            permit.scope === requirement.scope &&
            requirement.validityTypes.includes(permit.validityType) &&
            this.samePremises(branch, permit.branchLocationSnapshot) &&
            this.isInForce(permit, today)
        );

        if (matching) {
          satisfied.push(requirement.requirementKey);
        } else {
          missing.push(requirement.requirementKey);
        }
      }

      result.set(key, {
        canPost: identityReady && missing.length === 0,
        identityReady,
        branchActive: branch.isActive === true,

        requirements: requirements.map((item) => ({
          requirementKey: item.requirementKey,
          authorityName: item.authorityName,
          satisfied: satisfied.includes(item.requirementKey),
        })),

        missingRequirementKeys: missing,

        reason: !identityReady
          ? "employer_or_branch_ineligible"
          : missing.length
            ? "missing_current_facility_permits"
            : null,
      });
    }

    return result;
  }

  // ───────────────────── SINGLE-BRANCH READINESS ─────────────────────

  /**
   * Preserve the existing single-branch API.
   *
   * Both single-branch and batch reads now share the same
   * underlying eligibility evaluation.
   *
   * Marketplace writes must activate due renewals and recheck
   * readiness in their own transaction/session.
   */
  static async getBranchReadiness({ businessId, branchId, session = null }) {
    this.assertId(branchId, "branch ID");

    const readinessByBranchId = await this.getBranchesReadiness({
      businessId,
      branchIds: [branchId],
      session,
    });

    return readinessByBranchId.get(String(branchId));
  }

  // ───────────────────── EMPLOYER-FACING PERMIT HISTORY ─────────────────────

  /**
   * Retain permit and renewal history without exposing
   * private document storage references.
   */
  static async listBranchPermits({ businessId, branchId, actorUserId }) {
    await this.assertEmployerManager({
      businessId,
      actorUserId,
    });

    await this.getOwnedBranch({
      businessId,
      branchId,
    });

    const permits = await FacilityPermit.find({
      business: businessId,
      branch: branchId,
    })
      .select("-documentRef")
      .sort({
        submittedAt: -1,
        _id: -1,
      })
      .lean();

    const readiness = await this.getBranchReadiness({
      businessId,
      branchId,
    });

    return {
      permits,
      readiness,
    };
  }
}

module.exports = FacilityPermitVerificationService;
