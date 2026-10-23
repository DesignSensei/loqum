// server.js

const path = require("path");
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const methodOverride = require("method-override");
const expressLayouts = require("express-ejs-layouts");
const csrf = require("@dr.pogodin/csurf");
const cookieParser = require("cookie-parser");
const passport = require("passport");
const mongoose = require("mongoose");

const { startBackgroundJobs, stopBackgroundJobs } = require("./jobs");

const attachViewLocals = require("./middleware/viewLocalsMiddleware");
const { attachNotificationLocals } = require("./middleware/notificationMiddleware");

const connectDB = require("./config/db");
const logger = require("./utils/logger");

const authRoutes = require("./routes/authRoutes");
const adminRoutes = require("./routes/adminRoutes");
const onboardingRoutes = require("./routes/onboardingRoutes");
const professionalRoutes = require("./routes/professionalRoutes");
const employerRoutes = require("./routes/employerRoutes");
const accountRoutes = require("./routes/accountRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const jobRoutes = require("./routes/jobRoutes");
const webhookRoutes = require("./routes/webhookRoutes");

// ───────────────────── APPLICATION ─────────────────────

const app = express();

const PORT = process.env.PORT || 3000;

let server = null;
let isShuttingDown = false;
let backgroundJobsStarted = false;

app.disable("x-powered-by");

function wantsJSON(req) {
  const accept = req.get("Accept") || "";

  return req.xhr || Boolean(req.is("application/json")) || accept.includes("application/json");
}

// ───────────────────── WEBHOOKS ─────────────────────

// Webhooks run before JSON parsing and CSRF middleware.
// Each webhook route must validate the provider signature.

app.use("/webhooks", webhookRoutes);

// ───────────────────── REQUEST PARSERS ─────────────────────

app.use(cookieParser());

app.use(
  express.urlencoded({
    extended: true,
  })
);

app.use(express.json());

app.use(methodOverride("_method"));

// ───────────────────── STATIC FILES ─────────────────────

app.use(express.static(path.join(__dirname, "public")));

// ───────────────────── VIEW ENGINE ─────────────────────

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(expressLayouts);

// ───────────────────── SESSION ─────────────────────

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    name: "connect.sid",

    resave: false,
    saveUninitialized: false,

    store: MongoStore.create({
      mongoUrl: process.env.MONGO_URI,
      collectionName: "sessions",
    }),

    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  })
);

// ───────────────────── PASSPORT ─────────────────────

require("./config/passport")(passport);

app.use(passport.initialize());
app.use(passport.session());

// ───────────────────── REQUEST LOGGING ─────────────────────

app.use((req, res, next) => {
  res.on("finish", () => {
    // Log the path without query-string parameters.
    const message = `${req.method} ${req.path} ${res.statusCode}`;

    const meta = {
      user: req.user?.email || "Guest",
      timestamp: new Date().toISOString(),
    };

    logger.info(message, meta);
  });

  next();
});

// ───────────────────── CSRF PROTECTION ─────────────────────

const csrfProtection = csrf({
  cookie: true,
});

app.use(csrfProtection);

// ───────────────────── VIEW LOCALS ─────────────────────

app.use(attachNotificationLocals);
app.use(attachViewLocals);

// ───────────────────── ROUTES ─────────────────────

app.use(authRoutes);
app.use(accountRoutes);

app.use("/jobs", jobRoutes);
app.use("/payments", paymentRoutes);
app.use("/notifications", notificationRoutes);

app.use("/onboarding", onboardingRoutes);
app.use("/admin", adminRoutes);
app.use("/professional", professionalRoutes);
app.use("/employer", employerRoutes);

// ───────────────────── NOT FOUND ─────────────────────

app.use((req, res) => {
  if (wantsJSON(req)) {
    return res.status(404).json({
      success: false,
      message: "The requested resource was not found.",
    });
  }

  return res.status(404).render("errors/not-found", {
    layout: "layouts/error-layout",
    title: "Not Found",
    wfPage: "66b93fd9c65755b8a91df18e",
  });
});

// ───────────────────── GLOBAL ERROR HANDLING ─────────────────────

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  const isCSRFError = err?.code === "EBADCSRFTOKEN";

  const statusCode = isCSRFError
    ? 403
    : Number.isInteger(err?.statusCode) && err.statusCode >= 400 && err.statusCode <= 599
      ? err.statusCode
      : 500;

  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0",
  });

  if (isCSRFError) {
    const message =
      "Session expired or security token invalid. Please refresh the page and try again.";

    if (wantsJSON(req)) {
      return res.status(403).json({
        success: false,
        message,
        code: "INVALID_CSRF_TOKEN",
      });
    }

    return res.status(403).render("errors/error", {
      layout: "layouts/error-layout",
      title: "Session Expired",
      message,
      wfPage: "66b93fd9c65755b8a91df18e",
    });
  }

  if (statusCode === 404) {
    if (wantsJSON(req)) {
      return res.status(404).json({
        success: false,
        message: "The requested resource was not found.",
      });
    }

    return res.status(404).render("errors/not-found", {
      layout: "layouts/error-layout",
      title: "Not Found",
      wfPage: "66b93fd9c65755b8a91df18e",
    });
  }

  logger.error(
    `[${statusCode}] ${req.method} ${req.path} :: ${
      err?.message || "Unexpected error"
    }\n${err?.stack || ""}`
  );

  const message =
    statusCode >= 500
      ? "Something went wrong. Please try again."
      : err?.message || "Unable to complete the request.";

  if (wantsJSON(req)) {
    return res.status(statusCode).json({
      success: false,
      message,
    });
  }

  return res.status(statusCode).render("errors/error", {
    layout: "layouts/error-layout",
    title: "Error",
    message,
    wfPage: "66b93fd9c65755b8a91df18e",
  });
});

// ───────────────────── GRACEFUL SHUTDOWN ─────────────────────

async function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  logger.info(`${signal} received. Shutting down gracefully.`);

  if (backgroundJobsStarted) {
    stopBackgroundJobs();
  }

  const closeDatabase = async () => {
    try {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
        logger.info("MongoDB connection closed.");
      }

      logger.info("Graceful shutdown completed.");
      process.exit(0);
    } catch (error) {
      logger.error("Graceful shutdown failed:", error);
      process.exit(1);
    }
  };

  if (!server || !server.listening) {
    server = null;
    await closeDatabase();
    return;
  }

  server.close(async (error) => {
    if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
      logger.error("HTTP server shutdown failed:", error);
      process.exit(1);
    }

    server = null;

    logger.info(error ? "HTTP server was already closed." : "HTTP server closed.");

    await closeDatabase();
  });
}

// ───────────────────── SHUTDOWN SIGNALS ─────────────────────

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

// ───────────────────── SERVER STARTUP ─────────────────────

(async () => {
  try {
    await connectDB();

    server = app.listen(PORT, async () => {
      logger.info(`Server running on http://localhost:${PORT}`);

      if (process.env.NODE_ENV !== "production") {
        logger.info("Background jobs disabled in development.");
        return;
      }

      try {
        await startBackgroundJobs();

        backgroundJobsStarted = true;

        logger.info("Background jobs enabled.");
      } catch (error) {
        logger.error("Background job startup failed:", error);

        await shutdown("BACKGROUND_JOB_STARTUP_FAILED");
      }
    });
  } catch (error) {
    logger.error("Startup failed:", error);

    if (backgroundJobsStarted) {
      stopBackgroundJobs();
    }

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }

    process.exit(1);
  }
})();
