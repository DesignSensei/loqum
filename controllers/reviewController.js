// controllers/reviewController.js
const ReviewService = require("../services/reviewService");

exports.createReview = async (req, res, next) => {
  try {
    const { targetId, targetModel, rating, comment } = req.body;

    const review = await ReviewService.createReview({
      reviewerId: req.user._id,
      targetId,
      targetModel,
      rating,
      comment,
      targetDoc: req.targetDoc,
    });

    return res.status(201).json({ message: "Review submitted successfully.", review });
  } catch (error) {
    next(error);
  }
};

exports.getReviews = async (req, res, next) => {
  try {
    const reviews = await ReviewService.getReviews(req.params.targetId);
    return res.status(200).json({ reviews });
  } catch (error) {
    next(error);
  }
};

exports.deleteReview = async (req, res, next) => {
  try {
    await ReviewService.deleteReview(req.review);
    return res.status(200).json({ message: "Review deleted successfully." });
  } catch (error) {
    next(error);
  }
};
