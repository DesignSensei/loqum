// services/shifts/shiftPostingRateService.js

const ShiftPricingService = require("./shiftPricingService");

class ShiftPostingRateService {
  /* ───────────────────── RATE RESOLUTION ───────────────────── */

  static async resolve({
    pricing,
    employerProfile,
    currentTime = new Date(),
    session = null,
  }) {
    const SubscriptionService = require("../subscriptionService");

    const standardRate = ShiftPricingService.normalizeFinancialRate(
      pricing.platformFeeRate,
      "platformFeeRate"
    );

    const standardSnapshots = {
      standardBasePlatformFeeRate: standardRate,
      basePlatformFeeRate: standardRate,
      overtimePlatformFeeRate: standardRate,
      basePlatformFeeBenefitSource: "standard",
      basePlatformFeeSubscription: null,
    };

    const benefits =
      await SubscriptionService.getActiveSubscriptionBenefits(
        {
          employerProfileId: employerProfile._id,
          currentTime,
        },
        { session }
      );

    if (!benefits || benefits.basePlatformFeeRate == null) {
      return standardSnapshots;
    }

    const planSnapshot = benefits.subscription.planSnapshot;

    const normalizeMarketValue = (value) =>
      String(value || "").trim().toUpperCase();

    // A benefit belongs to its purchased country and currency.
    const marketMatches =
      normalizeMarketValue(planSnapshot.countryCode) ===
        normalizeMarketValue(employerProfile.countryCode) &&
      normalizeMarketValue(planSnapshot.currency) ===
        normalizeMarketValue(employerProfile.currency) &&
      normalizeMarketValue(planSnapshot.countryCode) ===
        normalizeMarketValue(pricing.countryCode) &&
      normalizeMarketValue(planSnapshot.currency) ===
        normalizeMarketValue(pricing.currency);

    if (!marketMatches) {
      return standardSnapshots;
    }

    const subscriptionRate =
      ShiftPricingService.normalizeFinancialRate(
        benefits.basePlatformFeeRate,
        "subscriptionBasePlatformFeeRate"
      );

    // A subscription must never increase the standard BASE fee.
    if (subscriptionRate >= standardRate) {
      return standardSnapshots;
    }

    return {
      standardBasePlatformFeeRate: standardRate,
      basePlatformFeeRate: subscriptionRate,
      overtimePlatformFeeRate: standardRate,
      basePlatformFeeBenefitSource: "subscription",
      basePlatformFeeSubscription: String(benefits.subscriptionId),
    };
  }

  /* ───────────────────── SNAPSHOT COMPARISON ───────────────────── */

  static snapshotsMatch(left, right) {
    return (
      left.standardBasePlatformFeeRate ===
        right.standardBasePlatformFeeRate &&
      left.basePlatformFeeRate === right.basePlatformFeeRate &&
      left.overtimePlatformFeeRate === right.overtimePlatformFeeRate &&
      left.basePlatformFeeBenefitSource ===
        right.basePlatformFeeBenefitSource &&
      String(left.basePlatformFeeSubscription || "") ===
        String(right.basePlatformFeeSubscription || "")
    );
  }
}

module.exports = ShiftPostingRateService;
