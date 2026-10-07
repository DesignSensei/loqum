// controllers/professionalShiftApplicationController.js

const ShiftApplicationService = require("../services/shiftApplicationService");
const ShiftQueryService = require("../services/shifts/shiftQueryService");
const ShiftViewService = require("../services/shifts/shiftViewService");

const { createServiceError } = require("../services/helpers/serviceErrorHelper");
const { normalizeObjectId } = require("../services/helpers/serviceValidationHelpers");

const logger = require("../utils/logger");

/**
 * Professional application commands: createApplication and withdrawApplication.
 *
 * Mount behind authentication, professional-role and CSRF middleware, matching
 * the employer router. Profile identity is always derived from the signed-in
 * user and rechecked by ShiftQueryService, never accepted from request data.
 *
 * createApplication requires params.shiftId. An occurrence target may come from
 * params.occurrenceId or body.occurrenceId; conflicting values are rejected.
 * withdrawApplication requires params.applicationId and supports an optional
 * params.shiftId for nested routes, verifying that parent before mutation.
 *
 * ShiftApplicationService remains the authority for transactional eligibility,
 * funding, capacity, schedule conflicts, replacement rounds and withdrawal.
 * Withdrawing an application does not cancel an accepted assignment.
 */

/* ─────────────────────────────── HELPERS ─────────────────────────────── */

function setNoStoreHeaders(res) {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0",
  });
}

function createControllerError({ message, code, statusCode = 400 }) {
  return createServiceError({
    name: "ProfessionalShiftApplicationControllerError",
    message,
    code,
    statusCode,
  });
}

async function getOwnedProfessionalProfile(req) {
  if (!req.user?._id) {
    throw createControllerError({
      message: "Sign in to manage your shift applications.",
      code: "AUTHENTICATION_REQUIRED",
      statusCode: 401,
    });
  }

  return ShiftQueryService.getProfessionalProfileForUser(
    req.user._id,
    req.professionalProfile || null
  );
}

function getOccurrenceTarget(req) {
  const routeId = req.params?.occurrenceId;
  const bodyId = req.body?.occurrenceId;

  const normalizeOptionalId = (value) =>
    value == null || value === ""
      ? null
      : normalizeObjectId({
          value,
          fieldName: "occurrence ID",
          createError: createControllerError,
        });

  const routeTarget = normalizeOptionalId(routeId);
  const bodyTarget = normalizeOptionalId(bodyId);

  if (routeTarget && bodyTarget && String(routeTarget) !== String(bodyTarget)) {
    throw createControllerError({
      message: "The route and application occurrence targets do not match.",
      code: "CONFLICTING_APPLICATION_OCCURRENCE",
    });
  }

  return routeTarget || bodyTarget || null;
}

function buildApplicationResponse(application) {
  // The query serializer removes employerPrivateNote and staff review metadata.
  const dto = ShiftQueryService.buildProfessionalApplicationView(application);

  return ShiftViewService.buildProfessionalApplicationView(dto);
}

function handleJsonError({ res, error, logContext, fallbackMessage, fallbackCode }) {
  const operational = [
    "ProfessionalShiftApplicationControllerError",
    "ShiftServiceError",
    "ShiftApplicationServiceError",
    "ShiftAssignmentServiceError",
    "ShiftOccurrenceReconciliationServiceError",
  ].includes(error?.name);

  const requestedStatus = Number(error?.statusCode);

  const statusCode =
    operational &&
    Number.isInteger(requestedStatus) &&
    requestedStatus >= 400 &&
    requestedStatus <= 599
      ? requestedStatus
      : 500;

  const expose = operational && statusCode < 500;

  if (statusCode >= 500) {
    logger.error(`${logContext}:`, error);
  } else {
    logger.warn(`${logContext} rejected: ${error.code || "UNKNOWN"}`);
  }

  const response = {
    success: false,
    message: expose ? error.message : fallbackMessage,
    code: expose ? error.code || fallbackCode : fallbackCode,
  };

  // Expose only known professional-facing conflict facts, not arbitrary error payloads.
  if (expose && error.details && typeof error.details === "object") {
    const details = {};

    for (const field of [
      "status",
      "conflictingShiftId",
      "conflictingOccurrenceId",
      "conflictingSlotNumber",
    ]) {
      const value = error.details[field];

      if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) {
        details[field] = value;
      }
    }

    if (Object.keys(details).length) {
      response.details = details;
    }
  }

  setNoStoreHeaders(res);

  return res.status(statusCode).json(response);
}

/* ─────────────────────────────── APPLY FOR A SHIFT ─────────────────────────────── */

exports.createApplication = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const professional = await getOwnedProfessionalProfile(req);

    const replacementValue = req.body?.replacementForAssignmentId;

    const replacementForAssignmentId =
      replacementValue == null || replacementValue === ""
        ? null
        : normalizeObjectId({
            value: replacementValue,
            fieldName: "replaced assignment ID",
            createError: createControllerError,
          });

    const result = await ShiftApplicationService.createApplication({
      shiftId: req.params.shiftId,
      professionalProfileId: professional._id,
      occurrenceId: getOccurrenceTarget(req),
      replacementForAssignmentId,
      note: req.body?.note,
    });

    const application = buildApplicationResponse(result.application);

    return res.status(result.created === true ? 201 : 200).json({
      success: true,
      message:
        result.idempotent === true
          ? "You have already applied for this opportunity."
          : "Your Shift application has been submitted.",
      created: result.created === true,
      idempotent: result.idempotent === true,
      application,
      shiftDetailsUrl: ShiftViewService.professionalDetailsUrl(application.shiftId),
      myShiftsUrl: ShiftViewService.getProfessionalMyShiftsUrl(),
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Professional Shift application submission",
      fallbackMessage: "Your application could not be submitted. Please try again.",
      fallbackCode: "SHIFT_APPLICATION_CREATION_FAILED",
    });
  }
};

/* ─────────────────────────────── WITHDRAW APPLICATION ─────────────────────────────── */

exports.withdrawApplication = async (req, res) => {
  setNoStoreHeaders(res);

  try {
    const professional = await getOwnedProfessionalProfile(req);

    const applicationId = req.params.applicationId;

    if (req.params.shiftId != null) {
      const shiftId = normalizeObjectId({
        value: req.params.shiftId,
        fieldName: "Shift ID",
        createError: createControllerError,
      });

      const application = await ShiftApplicationService.getApplication({
        applicationId,
        professionalProfileId: professional._id,
      });

      if (String(application.shift?._id || application.shift) !== String(shiftId)) {
        throw createControllerError({
          message: "The application was not found for this Shift.",
          code: "SHIFT_APPLICATION_NOT_FOUND",
          statusCode: 404,
        });
      }
    }

    const result = await ShiftApplicationService.withdrawApplication({
      applicationId,
      professionalProfileId: professional._id,
      withdrawalReason: req.body?.withdrawalReason,
    });

    const application = buildApplicationResponse(result.application);

    return res.status(200).json({
      success: true,
      message: "Your Shift application has been withdrawn.",
      application,
      shiftDetailsUrl: ShiftViewService.professionalDetailsUrl(application.shiftId),
      myShiftsUrl: ShiftViewService.getProfessionalMyShiftsUrl(),
    });
  } catch (error) {
    return handleJsonError({
      res,
      error,
      logContext: "Professional Shift application withdrawal",
      fallbackMessage: "Your application could not be withdrawn. Please try again.",
      fallbackCode: "SHIFT_APPLICATION_WITHDRAWAL_FAILED",
    });
  }
};
