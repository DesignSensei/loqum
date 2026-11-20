// controllers/professionalController.js

const ProfessionalService = require("../services/professionalService");
const ProfessionalProfileService = require("../services/professionalProfileService");

// ───────────────────── AVAILABILITY FORM HELPERS ─────────────────────

const VALID_AVAILABILITY_STATUSES = new Set(["available", "unavailable", "busy", "paused"]);

const VALID_AVAILABILITY_MODES = new Set(["weekly", "dates"]);

const MAX_AVAILABLE_DATES = 90;
const MAX_AVAILABILITY_NOTE_LENGTH = 300;

function asArray(value) {
  if (value === undefined || value === null || value === "") {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function readFormString(value) {
  return typeof value === "string" ? value.trim() : null;
}

function isValidCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function formatAvailabilityDate(value) {
  const date = new Date(`${value}T12:00:00.000Z`);

  return date.toLocaleDateString("en-NG", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function restoreAvailabilityForm(availabilityView, submittedData) {
  if (!submittedData || typeof submittedData !== "object" || Array.isArray(submittedData)) {
    return availabilityView;
  }

  const view = {
    ...availabilityView,
  };

  const status = readFormString(submittedData.availabilityStatus);
  const mode = readFormString(submittedData.availabilityMode);
  const note = readFormString(submittedData.availabilityNote);

  if (status && VALID_AVAILABILITY_STATUSES.has(status)) {
    view.status = status;

    view.statusOptions = availabilityView.statusOptions.map((option) => ({
      ...option,
      selected: option.value === status,
    }));
  }

  if (mode && VALID_AVAILABILITY_MODES.has(mode)) {
    view.mode = mode;

    view.modeOptions = availabilityView.modeOptions.map((option) => ({
      ...option,
      selected: option.value === mode,
    }));
  }

  if (note !== null) {
    view.note = note.slice(0, MAX_AVAILABILITY_NOTE_LENGTH);
  }

  if (view.mode === "weekly") {
    const submittedWeekdays = asArray(
      submittedData.availableWeekdays ?? submittedData["availableWeekdays[]"]
    );

    const weekdays = [
      ...new Set(
        submittedWeekdays
          .map((value) => {
            if (typeof value !== "string" && typeof value !== "number") {
              return null;
            }

            const text = String(value).trim();

            return /^[1-7]$/.test(text) ? Number(text) : null;
          })
          .filter((value) => value !== null)
      ),
    ].sort((a, b) => a - b);

    view.selectedWeekdays = weekdays;

    view.weekdayOptions = availabilityView.weekdayOptions.map((day) => ({
      ...day,
      selected: weekdays.includes(day.value),
    }));
  }

  if (view.mode === "dates") {
    const submittedDates = asArray(
      submittedData.availableDates ?? submittedData["availableDates[]"]
    );

    const dates = [
      ...new Set(
        submittedDates
          .filter((value) => typeof value === "string")
          .map((value) => value.trim())
          .filter(isValidCalendarDate)
      ),
    ]
      .sort()
      .slice(0, MAX_AVAILABLE_DATES);

    view.selectedDates = dates.map((date) => ({
      value: date,
      label: formatAvailabilityDate(date),
    }));
  }

  return view;
}

function isAvailabilityValidationError(error) {
  return (
    error?.statusCode === 400 || error?.name === "ValidationError" || error?.name === "CastError"
  );
}

function getAvailabilityErrorMessage(error) {
  if (error?.name !== "ValidationError") {
    return error?.message || "Invalid availability information.";
  }

  const messages = Object.values(error.errors || {})
    .map((item) => item.message)
    .filter(Boolean);

  return messages.length > 0
    ? [...new Set(messages)].join(" ")
    : "Please review your availability information and try again.";
}

// ───────────────────── PROFILE PAGE RENDERER ─────────────────────

/**
 * Shared renderer for professional profile requests.
 *
 * All view models are prepared by ProfessionalProfileService.
 *
 * On availability validation failure, submitted form values
 * are restored for presentation without modifying the
 * persisted professional profile.
 *
 * CSRF tokens are supplied globally through res.locals.
 */

async function renderProfessionalProfile(
  req,
  res,
  {
    activeTab = "overview",
    saved = false,
    errorMessage = null,
    statusCode = 200,
    submittedAvailability = null,
  } = {}
) {
  const profileData = await ProfessionalProfileService.getProfileData({
    actorUser: req.user,
    professionalProfile: req.professionalProfile,
    activeTab,
  });

  if (submittedAvailability) {
    profileData.availabilityView = restoreAvailabilityForm(
      profileData.availabilityView,
      submittedAvailability
    );
  }

  return res.status(statusCode).render("professional/profile/index", {
    layout: "layouts/app-layout",

    title: "My Profile",

    breadcrumbs: [
      {
        label: "Home",
        url: "/professional/dashboard",
      },
      {
        label: "My Profile",
        url: null,
      },
    ],

    scripts: '<script src="/js/professional/profile.js"></script>',

    ...profileData,

    saved,
    errorMessage,
  });
}

// ───────────────────── PROFESSIONAL DASHBOARD ─────────────────────

exports.getDashboard = async (req, res, next) => {
  try {
    const dashboardData = await ProfessionalService.getDashboardData(req.professionalProfile);

    return res.render("professional/dashboard/index", {
      layout: "layouts/app-layout",

      title: "Dashboard",

      breadcrumbs: [
        {
          label: "Home",
          url: "/professional/dashboard",
        },
        {
          label: "Dashboard",
          url: null,
        },
      ],

      ...dashboardData,
    });
  } catch (error) {
    return next(error);
  }
};

// ───────────────────── PROFESSIONAL PROFILE ─────────────────────

/**
 * GET /professional/profile
 *
 * Supported tabs are validated by ProfessionalProfileService.
 */

exports.getProfile = async (req, res, next) => {
  try {
    const activeTab = typeof req.query.tab === "string" ? req.query.tab : "overview";

    const saved = activeTab === "availability" && req.query.saved === "1";

    return await renderProfessionalProfile(req, res, {
      activeTab,
      saved,
    });
  } catch (error) {
    return next(error);
  }
};

// ───────────────────── UPDATE AVAILABILITY ─────────────────────

/**
 * POST /professional/profile/availability
 *
 * ProfessionalProfileService owns:
 * - Profile ownership validation;
 * - Availability status validation;
 * - Weekly and specific-date validation;
 * - Approved availability field updates;
 * - Preservation of inactive-mode preferences;
 * - Persistence through Mongoose document save().
 *
 * This controller handles HTTP responses and form feedback.
 */

exports.postUpdateAvailability = async (req, res, next) => {
  try {
    await ProfessionalProfileService.updateAvailability({
      actorUser: req.user,
      data: req.body,
    });

    return res.redirect(303, "/professional/profile?tab=availability&saved=1");
  } catch (error) {
    if (!isAvailabilityValidationError(error)) {
      return next(error);
    }

    try {
      return await renderProfessionalProfile(req, res, {
        activeTab: "availability",
        saved: false,
        errorMessage: getAvailabilityErrorMessage(error),
        statusCode: 400,
        submittedAvailability: req.body,
      });
    } catch (renderError) {
      return next(renderError);
    }
  }
};
