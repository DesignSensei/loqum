// routes/jobRoutes.js

const express = require("express");

const router = express.Router();

const jobMarketplaceController = require("../controllers/jobMarketplaceController");

/* ─────────────────────────────── PUBLIC JOB MARKETPLACE ─────────────────────────────── */

/**
 * Public permanent-Job marketplace.
 *
 */

/* ─────────────────────────────── LIST ─────────────────────────────── */

router.get("/", jobMarketplaceController.getJobs);

/* ─────────────────────────────── DETAIL ─────────────────────────────── */

/**
 * Marketplace identity is the JobPublication ID.
 *
 * A public URL therefore points to one exact immutable publication cycle:
 */
router.get("/:publicationId", jobMarketplaceController.getJob);

module.exports = router;
