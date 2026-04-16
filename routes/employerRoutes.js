// routes/employerRoutes.js

const express = require("express");
const router = express.Router();
const {
  isAuthenticated,
  isVerified,
  hasRole,
} = require("../middleware/authMiddleware");
const employerController = require("../controllers/employerController");

/* ---------- Middleware ---------- */
router.use(isAuthenticated, isVerified, hasRole("employer"));

/* ---------- Public pages (GET) ---------- */
router.get("/", employerController.getDashboard);

module.exports = router;
