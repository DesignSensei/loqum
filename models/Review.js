// models/Review.js

const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema(
  {
    reviewer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    target: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      refPath: "targetModel",
    },

    targetModel: {
      type: String,
      required: true,
      enum: ["ProfessionalProfile", "EmployerProfile"],
    },

    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },

    comment: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
  },
  { timestamps: true }
);

// Prevent a user from reviewing the same target more than once
reviewSchema.index({ reviewer: 1, target: 1 }, { unique: true });

/* ---------- Static Method (Ratings Recalculation) ---------- */
// Recomputes and updates averageRating and totalReviews on the target profile whenever a review is created or deleted.
reviewSchema.statics.recalculateRatings = async function (targetId, targetModel) {
  // Aggregate all reviews for this target to get the average rating and total count
  const result = await this.aggregate([
    { $match: { target: new mongoose.Types.ObjectId(targetId) } },
    { $group: { _id: "$target", avg: { $avg: "$rating" }, count: { $sum: 1 } } },
  ]);

  // Dynamically resolve the target model (ProfessionalProfile or EmployerProfile)
  const TargetModel = mongoose.model(targetModel);
  if (result.length > 0) {
    // Update the profile with the fresh average (1 decimal place) and review count
    await TargetModel.findByIdAndUpdate(targetId, {
      averageRating: Math.round(result[0].avg * 10) / 10,
      totalReviews: result[0].count,
    });
  } else {
    // No reviews remain (e.g. last one was deleted) — reset both fields
    await TargetModel.findByIdAndUpdate(targetId, { averageRating: 0, totalReviews: 0 });
  }
};

/* ---------- Post-save Hook ---------- */
// Runs automatically after a review is saved to the database
reviewSchema.post("save", async function () {
  // Triggers recalculation so the target profile's rating stays in sync.
  await this.constructor.recalculateRatings(this.target, this.targetModel);
});

/* ---------- Post-delete Hook ---------- */
// Runs automatically after a review is deleted via findOneAndDelete().
reviewSchema.post("findOneAndDelete", async function (doc) {
  if (doc) await doc.constructor.recalculateRatings(doc.target, doc.targetModel);
});

module.exports = mongoose.model("Review", reviewSchema);
