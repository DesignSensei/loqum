// utils/reference.js

const crypto = require("crypto");

const getDateStamp = () => {
  const now = new Date();

  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return `${year}${month}${day}`;
};

const getRandomCode = (length = 8) => {
  return crypto.randomBytes(length).toString("hex").slice(0, length).toUpperCase();
};

exports.generateReference = (prefix = "LQ") => {
  return `${prefix}-${getDateStamp()}-${getRandomCode()}`;
};

exports.generateWalletFundingReference = () => {
  return exports.generateReference("LQ-WALLET");
};

exports.generateShiftFundingReference = () => {
  return exports.generateReference("LQ-SHIFT");
};

exports.generateEscrowReference = () => {
  return exports.generateReference("LQ-ESCROW");
};

exports.generateWithdrawalReference = () => {
  return exports.generateReference("LQ-WITHDRAWAL");
};

exports.generateWithdrawalReversalReference = () => {
  return exports.generateReference("LQ-WITHDRAWAL-REVERSAL");
};

exports.generateRefundReference = () => {
  return exports.generateReference("LQ-REFUND");
};

exports.generatePlatformFeeReference = () => {
  return exports.generateReference("LQ-FEE");
};

exports.generateSettlementReference = () => {
  return exports.generateReference("LQ-SETTLEMENT");
};

exports.generateGroupReference = () => {
  return exports.generateReference("LQ-GROUP");
};

exports.generatePin = (length = 6) => {
  const min = 10 ** (length - 1);
  const max = 10 ** length - 1;

  return String(Math.floor(Math.random() * (max - min + 1)) + min);
};
