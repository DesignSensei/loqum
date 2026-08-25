// server.js

const path = require("path");
require("dotenv").config();

// Core Libraries
const express = require("express");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const methodOverride = require("method-override");
const expressLayouts = require("express-ejs-layouts");
const csrf = require("@dr.pogodin/csurf");
const cookieParser = require("cookie-parser");
const passport = require("passport");
const mongoose = require("mongoose");

// Jobs
// const { startBackgroundJobs, stopBackgroundJobs } = require("./jobs");

// Utilities
const attachViewLocals = require("./middleware/viewLocalsMiddleware");

const { attachNotificationLocals } = require("./middleware/notificationMiddleware");

// Pre-defined modules
const connectDB = require("./config/db");
const logger = require("./utils/logger");

// Routes
const authRoutes = require("./routes/authRoutes");
const adminRoutes = require("./routes/adminRoutes");
const onboardingRoutes = require("./routes/onboardingRoutes");
const professionalRoutes = require("./routes/professionalRoutes");
const employerRoutes = require("./routes/employerRoutes");
const accountRoutes = require("./routes/accountRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
// const reviewRoutes = require("./routes/reviewRoutes");
const webhookRoutes = require("./routes/webhookRoutes");

/* ---------- Initialize App ---------- */

const app = express();

const PORT = process.env.PORT || 3000;

let server = null;
let isShuttingDown = false;

/* ---------- Parsers ---------- */

app.use(cookieParser());

app.use(
  express.urlencoded({
    extended: true,
  })
);

app.use(express.json());

app.use(methodOverride("_method"));

/* ---------- Public webhook routes ---------- */

app.use("/webhooks", webhookRoutes);

/* ---------- Static files ---------- */

app.use(express.static(path.join(__dirname, "public")));

/* ---------- View engine ---------- */

app.set("view engine", "ejs");

app.set("views", path.join(__dirname, "views"));

/* ---------- Use layout ---------- */

app.use(expressLayouts);

/* ---------- Session ---------- */

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

/* ---------- Passport ---------- */

require("./config/passport")(passport);

app.use(passport.initialize());

app.use(passport.session());

/* ---------- Request logging ---------- */

app.use((req, res, next) => {
  res.on("finish", () => {
    const message = `${req.method} ${req.originalUrl} ${res.statusCode}`;

    const meta = {
      user: req.user?.email || "Guest",

      timestamp: new Date().toISOString(),
    };

    logger.info(message, meta);
  });

  next();
});

/* ---------- CSRF Middleware ---------- */

const csrfProtection = csrf({
  cookie: true,
});

app.use(csrfProtection);

/* ---------- Header notifications ---------- */

app.use(attachNotificationLocals);

/* ---------- View locals ---------- */

app.use(attachViewLocals);

/* ---------- Routes ---------- */

app.use(authRoutes);

app.use(accountRoutes);

app.use("/payments", paymentRoutes);

app.use("/notifications", notificationRoutes);

app.use("/onboarding", onboardingRoutes);

app.use("/admin", adminRoutes);

app.use("/professional", professionalRoutes);

app.use("/employer", employerRoutes);

// app.use("/reviews", reviewRoutes);

/* ---------- Catch unmatched routes (404) ---------- */

app.use((req, res) => {
  return res.status(404).render("errors/not-found", {
    layout: "layouts/error-layout",

    title: "Not Found",

    wfPage: "66b93fd9c65755b8a91df18e",
  });
});

/* ---------- Global Error Handler (CSRF + others) ---------- */

app.use((err, req, res, next) => {
  // CSRF errors.
  if (err.code === "EBADCSRFTOKEN") {
    res.status(403);

    res.locals.error = "Session expired or form tampered with. Please retry.";

    return res.redirect(req.get("Referer") || "/");
  }

  const statusCode = err.statusCode || 500;

  if (statusCode === 404) {
    return res.status(404).render("errors/not-found", {
      layout: "layouts/error-layout",

      title: "Not Found",

      wfPage: "66b93fd9c65755b8a91df18e",
    });
  }

  logger.error(
    `[${statusCode}] ${req.method} ${req.originalUrl} :: ` + `${err.message}\n${err.stack || ""}`
  );

  return res.status(statusCode).render("errors/error", {
    layout: "layouts/error-layout",

    title: "Error",

    message: err.message || "Something went wrong",

    wfPage: "66b93fd9c65755b8a91df18e",
  });
});

/* ---------- Graceful shutdown ---------- */

async function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  logger.info(`${signal} received. Shutting down gracefully.`);

  /*
   * Stop scheduling new background work before closing the
   * HTTP server or MongoDB connection.
   */
  stopBackgroundJobs();

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

  if (!server) {
    await closeDatabase();

    return;
  }

  server.close(async (error) => {
    if (error) {
      logger.error("HTTP server shutdown failed:", error);

      process.exit(1);

      return;
    }

    logger.info("HTTP server closed.");

    await closeDatabase();
  });
}

/* ---------- Shutdown signals ---------- */

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

/* ---------- Start server and connect to database ---------- */

(async () => {
  try {
    await connectDB();

    server = app.listen(PORT, () => {
      logger.info(`Server running on http://localhost:${PORT}`);

      // startBackgroundJobs();
    });
  } catch (error) {
    logger.error("Startup failed:", error);

    // stopBackgroundJobs();

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }

    process.exit(1);
  }
})();
