// utils/money.js

/* ---------- Round money safely to 2 decimal places ---------- */
exports.roundMoney = (amount) => {
  const numericAmount = Number(amount);

  if (!Number.isFinite(numericAmount)) {
    throw new Error("Invalid money amount");
  }

  return Math.round((numericAmount + Number.EPSILON) * 100) / 100;
};

/* ---------- Calculate professional pay ---------- */
exports.calculateProfessionalPay = (hourlyRate, billableHours) => {
  const rate = Number(hourlyRate);
  const hours = Number(billableHours);

  if (!Number.isFinite(rate) || rate < 0) {
    throw new Error("Invalid hourly rate");
  }

  if (!Number.isFinite(hours) || hours < 0) {
    throw new Error("Invalid billable hours");
  }

  return exports.roundMoney(rate * hours);
};

/* ---------- Calculate Loqum employer-side platform fee ---------- */
exports.calculatePlatformFee = (professionalPay, platformFeeRate) => {
  const pay = Number(professionalPay);
  const feeRate = Number(platformFeeRate);

  if (!Number.isFinite(pay) || pay < 0) {
    throw new Error("Invalid professional pay");
  }

  if (!Number.isFinite(feeRate) || feeRate < 0) {
    throw new Error("Invalid platform fee rate");
  }

  return exports.roundMoney(pay * feeRate);
};

/* ---------- Calculate total amount employer pays ---------- */
exports.calculateEmployerCharge = (professionalPay, platformFee) => {
  const pay = Number(professionalPay);
  const fee = Number(platformFee);

  if (!Number.isFinite(pay) || pay < 0) {
    throw new Error("Invalid professional pay");
  }

  if (!Number.isFinite(fee) || fee < 0) {
    throw new Error("Invalid platform fee");
  }

  return exports.roundMoney(pay + fee);
};

/* ---------- Calculate full shift pricing ---------- */
exports.calculateShiftPricing = ({ hourlyRate, scheduledHours, platformFeeRate }) => {
  const estimatedProfessionalPay = exports.calculateProfessionalPay(hourlyRate, scheduledHours);

  const estimatedPlatformFee = exports.calculatePlatformFee(
    estimatedProfessionalPay,
    platformFeeRate
  );

  const estimatedEmployerCharge = exports.calculateEmployerCharge(
    estimatedProfessionalPay,
    estimatedPlatformFee
  );

  return {
    hourlyRate: exports.roundMoney(hourlyRate),
    scheduledHours,
    platformFeeRate,
    estimatedProfessionalPay,
    estimatedPlatformFee,
    estimatedEmployerCharge,
  };
};

/* ---------- Calculate extra amount employer needs to add ---------- */
exports.calculateTopUpRequired = (finalEmployerCharge, fundedAmount) => {
  const finalCharge = Number(finalEmployerCharge);
  const funded = Number(fundedAmount);

  if (!Number.isFinite(finalCharge) || finalCharge < 0) {
    throw new Error("Invalid final employer charge");
  }

  if (!Number.isFinite(funded) || funded < 0) {
    throw new Error("Invalid funded amount");
  }

  return exports.roundMoney(Math.max(finalCharge - funded, 0));
};

/* ---------- Calculate amount to refund to employer wallet ---------- */
exports.calculateRefundAmount = (fundedAmount, finalEmployerCharge) => {
  const funded = Number(fundedAmount);
  const finalCharge = Number(finalEmployerCharge);

  if (!Number.isFinite(funded) || funded < 0) {
    throw new Error("Invalid funded amount");
  }

  if (!Number.isFinite(finalCharge) || finalCharge < 0) {
    throw new Error("Invalid final employer charge");
  }

  return exports.roundMoney(Math.max(funded - finalCharge, 0));
};
