// server.js

const path = require("path");
require("dotenv").config();

// Core Libraries
const express = require("express");
const session = require("express-session");
const { MongoStore } = require("connect-mongo");
const methodOverride = require("method-override");
const expressLayouts = require("express-ejs-layouts");

// Pre-defined modules
const connectDB = require("./config/db");
const logger = require("./utils/logger");

// Routes

/* ---------- Initialize App ---------- */
const app = express();
const PORT = process.env.PORT || 3000;

/* ---------- App Level Middleware ---------- */
/* ---------- Parsers & static ---------- */
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
app.use(cookieParser());
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
  }),
);

/* ---------- Start server & Connect to database ---------- */
(async () => {
  try {
    await connectDB();
    app.listen(PORT, () =>
      logger.info(`Server running on http://localhost:${PORT}`),
    );
  } catch (err) {
    logger.error("Startup failed:", err);
    process.exit(1);
  }
})();
