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

// Utilities
const { getHomeRoute } = require("./utils/routeHelper");

// Pre-defined modules
const connectDB = require("./config/db");
const logger = require("./utils/logger");

// Routes
const authRoutes = require("./routes/authRoutes");
const adminRoutes = require("./routes/adminRoutes");
const onboardingRoutes = require("./routes/onboardingRoutes");
const professionalRoutes = require("./routes/professionalRoutes");
const employerRoutes = require("./routes/employerRoutes");
// const reviewRoutes = require("./routes/reviewRoutes");

/* ---------- Initialize App ---------- */
const app = express();
const PORT = process.env.PORT || 3000;

/* ---------- App Level Middleware ---------- */
/* ---------- Parsers & static ---------- */
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride("_method"));
app.use(express.static(path.join(__dirname, "public")));

/* ---------- View engine ---------- */
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

/* ---------- Use layout ---------- */
app.use(expressLayouts);

/* ---------- Request logging ---------- */
app.use((req, res, next) => {
  res.on("finish", () => {
    const message = `${req.method} ${req.originalUrl} ${res.statusCode}`;
    const meta = {
      user: req.user ? req.user.email : "Guest",
      timestamp: new Date().toISOString(),
    };
    logger.info(message, meta);
  });
  next();
});

/* ---------- Cookies + Session ---------- */
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

/* ---------- Passport Config ---------- */
require("./config/passport")(passport);

// Initialize Passport Middleware
app.use(passport.initialize());
app.use(passport.session());

/* ---------- CSRF Middleware ---------- */
const csrfProtection = csrf({ cookie: true });
app.use(csrfProtection);

/* ---------- Make session user & CSRF token available to all views ---------- */
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.csrfToken = req.csrfToken();
  res.locals.userHome = req.session.user ? getHomeRoute(req.session.user.role) : "/";
  next();
});

/* ---------- Mount Routes ---------- */
app.use(authRoutes);
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
  // CSRF errors
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

  // Log and show error page with explicit layout
  logger.error(
    `[${statusCode}] ${req.method} ${req.originalUrl} :: ${err.message}\n${err.stack || ""}`
  );

  return res.status(statusCode).render("errors/error", {
    layout: "layouts/error-layout",
    title: "Error",
    message: err.message || "Something went wrong",
    wfPage: "66b93fd9c65755b8a91df18e",
  });
});

/* ---------- Start server & Connect to database ---------- */
(async () => {
  try {
    await connectDB();
    app.listen(PORT, () => logger.info(`Server running on http://localhost:${PORT}`));
  } catch (err) {
    logger.error("Startup failed:", err);
    process.exit(1);
  }
})();
