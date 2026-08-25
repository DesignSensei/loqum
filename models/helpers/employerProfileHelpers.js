// models/helpers/employerProfileHelpers.js

const VERIFICATION_STATUSES_REQUIRING_CHECK = ["verified", "rejected", "needs_review"];

function hasValue(value) {
  return value !== null && value !== undefined && value !== "";
}

exports.hasAnyValue = function hasAnyValue(values) {
  return values.some(hasValue);
};

exports.validateVerificationState = function validateVerificationState(
  document,
  {
    label,
    pathPrefix,
    status,
    method,
    source,
    nameOnRecord,
    verifiedAt,
    lastCheckedAt,
    verifiedBy,
    verificationNote,
    rejectionReason,
  }
) {
  const methodPath = `${pathPrefix}VerificationMethod`;
  const sourcePath = `${pathPrefix}VerificationSource`;
  const namePath = `${pathPrefix}NameOnRecord`;
  const verifiedAtPath = `${pathPrefix}VerifiedAt`;
  const lastCheckedAtPath = `${pathPrefix}LastCheckedAt`;
  const verifiedByPath = `${pathPrefix}VerifiedBy`;
  const notePath = `${pathPrefix}VerificationNote`;
  const rejectionPath = `${pathPrefix}RejectionReason`;

  const verificationWasChecked = method !== "not_checked";

  const statusRequiresCheck = VERIFICATION_STATUSES_REQUIRING_CHECK.includes(status);

  if (method === "not_checked") {
    if (source !== "not_checked") {
      document.invalidate(
        sourcePath,
        `${label} verification source must be not_checked when the method is not_checked.`
      );
    }

    if (
      exports.hasAnyValue([nameOnRecord, verifiedAt, lastCheckedAt, verifiedBy, rejectionReason])
    ) {
      document.invalidate(
        methodPath,
        `${label} verification evidence cannot exist when the method is not_checked.`
      );
    }
  } else {
    if (source === "not_checked") {
      document.invalidate(
        sourcePath,
        `${label} verification source must identify the completed check.`
      );
    }

    if (!lastCheckedAt) {
      document.invalidate(
        lastCheckedAtPath,
        `${label} verification requires a last-checked timestamp.`
      );
    }
  }

  if (statusRequiresCheck && !verificationWasChecked) {
    document.invalidate(
      methodPath,
      `${label} ${status} status requires a completed verification method.`
    );
  }

  if (method === "manual" && statusRequiresCheck && !verifiedBy) {
    document.invalidate(
      verifiedByPath,
      `Manual ${label.toLowerCase()} verification requires a reviewer.`
    );
  }

  if (status === "verified") {
    if (!nameOnRecord) {
      document.invalidate(
        namePath,
        `Verified ${label.toLowerCase()} registration requires the name on record.`
      );
    }

    if (!verifiedAt) {
      document.invalidate(
        verifiedAtPath,
        `Verified ${label.toLowerCase()} registration requires a verification timestamp.`
      );
    }

    if (rejectionReason) {
      document.invalidate(
        rejectionPath,
        `Verified ${label.toLowerCase()} registration cannot retain a rejection reason.`
      );
    }
  } else if (verifiedAt) {
    document.invalidate(
      verifiedAtPath,
      `${label} verifiedAt may only be set when verification status is verified.`
    );
  }

  if (status === "rejected") {
    if (!rejectionReason) {
      document.invalidate(
        rejectionPath,
        `Rejected ${label.toLowerCase()} verification requires a rejection reason.`
      );
    }
  } else if (rejectionReason) {
    document.invalidate(
      rejectionPath,
      `${label} rejection reason may only be set when verification status is rejected.`
    );
  }

  if (status === "needs_review" && !verificationNote) {
    document.invalidate(notePath, `${label} needs_review status requires a verification note.`);
  }

  if (verifiedAt && lastCheckedAt && verifiedAt < lastCheckedAt) {
    document.invalidate(
      verifiedAtPath,
      `${label} verifiedAt cannot be earlier than lastCheckedAt.`
    );
  }
};
