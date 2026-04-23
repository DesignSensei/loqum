// middleware/reviewMiddleware.js

const mongoose = require("mongoose");
const Review = require("../models/Review");

exports.validateReview = (req, res, next) => {
  const { targetId, targetModel, rating } = req.body;

  if (!targetId || !targetModel) {
    return res.status(400).json({ message: "targetId and targetModel are required." });
  }

  if (!["ProfessionalProfile", "EmployerProfile"].includes(targetModel)) {
    return res.status(400).json({ message: "Invalid targetModel." });
  }

  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ message: "Rating must be between 1 and 5." });
  }

  if (!mongoose.Types.ObjectId.isValid(targetId)) {
    return res.status(400).json({ message: "Invalid targetId." });
  }

  next();
};

exports.canReview = async (req, res, next) => {
  try {
    const reviewer = req.user;
    const { targetId, targetModel } = req.body;

    // Admins can't review anyone
    if (reviewer.role === "admin") {
      return res.status(403).json({ message: "Admins cannot write reviews." });
    }

    // Professionals can only review employers
    if (reviewer.role === "professional" && targetModel !== "EmployerProfile") {
      return res.status(403).json({ message: "Professionals can only review employers." });
    }

    // Employers can only review professionals
    if (reviewer.role === "employer" && targetModel !== "ProfessionalProfile") {
      return res.status(403).json({ message: "Employers can only review professionals." });
    }

    const TargetModel = mongoose.model(targetModel);
    const targetDoc = await TargetModel.findById(targetId);

    if (!targetDoc) {
      return res.status(404).json({ message: "Profile not found." });
    }

    // Prevents a user (professional or employer) from reviewing their own profile
    if (targetDoc.user.toString() === reviewer._id.toString()) {
      return res.status(403).json({ message: "You cannot review your own profile." });
    }

    // Passess req.targetDoc forward for the next function
    req.targetDoc = targetDoc;
    next();
  } catch (error) {
    next(error);
  }
};

exports.hasAlreadyReviewed = async (req, res, next) => {
  try {
    const existing = await Review.findOne({
      reviewer: req.user._id,
      target: req.body.targetId,
    });

    if (existing) {
      return res.status(409).json({ message: "You have already reviewed this profile." });
    }

    next();
  } catch (error) {
    next(error);
  }
};

exports.canDeleteReview = async (req, res, next) => {
  try {
    const review = await Review.findById(req.params.reviewId);

    if (!review) {
      return res.status(404).json({ message: "Review not found." });
    }

    if (review.reviewer.toString() !== req.user._id.toString() && req.user.role !== "admin") {
      return res.status(403).json({ message: "Not authorized to delete this review." });
    }

    req.review = review; // pass it along so the controller doesn't re-fetch
    next();
  } catch (error) {
    next(error);
  }
};
