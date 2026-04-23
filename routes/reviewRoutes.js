// routes/reviewRoutes.js

const express = require("express");
const router = express.Router();
const reviewController = require("../controllers/reviewController");
const {
  canReview,
  hasAlreadyReviewed,
  canDeleteReview,
  validateReview,
} = require("../middleware/reviewMiddleware");
const { isAuthenticated } = require("../middleware/authMiddleware");

router.get("/:targetId", isAuthenticated, reviewController.getReviews);

router.post(
  "/",
  isAuthenticated,
  validateReview,
  canReview,
  hasAlreadyReviewed,
  reviewController.createReview
);

router.delete("/:reviewId", isAuthenticated, canDeleteReview, reviewController.deleteReview);

module.exports = router;
