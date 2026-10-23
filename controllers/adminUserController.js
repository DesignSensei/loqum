// controllers/adminUserController.js

const AdminUserQueryService = require("../services/adminUserQueryService");
const AdminUserViewService = require("../services/adminUserViewService");

const logger = require("../utils/logger");

// ───────────────────────── RESPONSE HELPERS ─────────────────────────

function setNoStoreHeaders(res) {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0",
  });
}

function sendError(res, error, operation) {
  const statusCode =
    Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 500
      ? error.statusCode
      : 500;

  if (statusCode === 500) {
    logger.error(`${operation}: ${error.message}`);
  }

  return res.status(statusCode).json({
    success: false,
    message: statusCode === 500 ? "Unable to complete the user management request." : error.message,
  });
}

// ───────────────────────── ADMIN USER PAGES ─────────────────────────

// Render Employers / Professionals Directory
exports.getUsersPage = async (req, res, next) => {
  try {
    const usersData = await AdminUserQueryService.listUsers({
      adminUserId: req.user?._id,
      role: req.query.role,
      search: req.query.search,
      status: req.query.status,
      accountStatus: req.query.accountStatus,
      page: req.query.page,
      limit: req.query.limit,
    });

    const usersView = AdminUserViewService.buildDirectoryView(usersData);

    const roleMetadata = AdminUserViewService.getRoleMetadata(usersView.role);

    setNoStoreHeaders(res);

    return res.render("admin/users/index", {
      layout: "layouts/app-layout",
      title: roleMetadata.plural,

      breadcrumbs: [
        {
          label: "Home",
          url: "/admin/dashboard",
        },
        {
          label: roleMetadata.plural,
          url: null,
        },
      ],

      csrfToken: req.csrfToken(),

      usersView,

      scripts: "",
    });
  } catch (error) {
    return next(error);
  }
};

// Render Individual Employer / Professional Details
exports.getUserDetailsPage = async (req, res, next) => {
  try {
    const userData = await AdminUserQueryService.getUserDetails({
      adminUserId: req.user?._id,
      userId: req.params.userId,
    });

    const userView = AdminUserViewService.buildUserDetailsView(userData);

    const roleMetadata = AdminUserViewService.getRoleMetadata(userView.role);

    setNoStoreHeaders(res);

    return res.render("admin/users/show", {
      layout: "layouts/app-layout",
      title: userView.heading,

      breadcrumbs: [
        {
          label: "Home",
          url: "/admin/dashboard",
        },
        {
          label: roleMetadata.plural,
          url: userView.backUrl,
        },
        {
          label: userView.heading,
          url: null,
        },
      ],

      csrfToken: req.csrfToken(),

      userView,

      scripts: `
        <script src="/js/admin/user-details.js"></script>
      `,
    });
  } catch (error) {
    return next(error);
  }
};

// ───────────────────────── ADMIN USER DATA ─────────────────────────

// Get Filtered Users and Verification Summary
exports.getUsersData = async (req, res) => {
  try {
    const result = await AdminUserQueryService.listUsers({
      adminUserId: req.user?._id,
      role: req.query.role,
      search: req.query.search,
      status: req.query.status,
      accountStatus: req.query.accountStatus,
      page: req.query.page,
      limit: req.query.limit,
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return sendError(res, error, "Get admin users data");
  }
};

// Get Individual User Profile and Verification Data
exports.getUserDetailsData = async (req, res) => {
  try {
    const result = await AdminUserQueryService.getUserDetails({
      adminUserId: req.user?._id,
      userId: req.params.userId,
    });

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return sendError(res, error, "Get admin user details");
  }
};
