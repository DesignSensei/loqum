// routes/employerRoutes.js

const express = require("express");
const router = express.Router();
const employerController = require("../controllers/pharmacistController");

/* ---------- Public pages (GET) ---------- */
router.get("/", employerController.getDashboard);

/* ---------- Action pages (POST}) ---------- */

module.exports = router;
