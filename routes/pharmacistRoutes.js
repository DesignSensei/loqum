// routes/pharmacistRoutes.js

const express = require("express");
const router = express.Router();
const pharmacistController = require("../controllers/pharmacistController");

/* ---------- Public pages (GET) ---------- */
router.get("/", pharmacistController.getDashboard);

/* ---------- Action pages (POST}) ---------- */

module.exports = router;
