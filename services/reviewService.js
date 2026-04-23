// services/reviewService.js

const mongoose = require("mongoose");
const Review = require("../models/Review");
const logger = require("../utils/logger");

class ReviewService {
  static async createReview({ reviewerId, targetId, targetModel, rating, comment, targetDoc }) {
    const review = new Review({
      reviewer: reviewerId,
      target: targetId,
      targetModel,
      rating,
      comment,
    });

    await review.save();

    // Push review reference onto the target profile
    targetDoc.reviews.push(review._id);
    await targetDoc.save();

    logger.info(`Review created by user: ${reviewerId} for ${targetModel}: ${targetId}`);
    return review;
  }

  static async getReviews(targetId) {
    const reviews = await Review.find({ target: targetId })
      .populate("reviewer", "firstName lastName")
      .sort({ createdAt: -1 });

    return reviews;
  }

  static async deleteReview(review) {
    await Review.findByIdAndDelete(review._id);

    // Remove review reference from the target profile
    const TargetModel = mongoose.model(review.targetModel);
    await TargetModel.findByIdAndUpdate(review.target, {
      $pull: { reviews: review._id },
    });

    logger.info(`Review: ${review._id} deleted from ${review.targetModel}: ${review.target}`);
  }
}

module.exports = ReviewService;
