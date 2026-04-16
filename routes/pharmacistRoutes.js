// routes/pharmacistRoutes.js

const express = require("express");
const router = express.Router();
const {
  isAuthenticated,
  isVerified,
  hasRole,
} = require("../middleware/authMiddleware");
const pharmacistController = require("../controllers/pharmacistController");

/* ---------- Middleware ---------- */
router.use(isAuthenticated, isVerified, hasRole("pharmacist"));

/* ---------- Public pages (GET) ---------- */
router.get("/", pharmacistController.getDashboard);

module.exports = router;
