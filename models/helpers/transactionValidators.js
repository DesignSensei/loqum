// models/helpers/transactionValidators.js

function sameId(left, right) {
  if (!left || !right) {
    return false;
  }

  return String(left._id || left) === String(right._id || right);
}

function hasAnyNonZeroBalanceDelta(balanceDelta) {
  if (!balanceDelta) {
    return false;
  }

  return [
    balanceDelta.availableBalance,
    balanceDelta.pendingBalance,
    balanceDelta.outstandingBalance,
  ].some((value) => Number(value || 0) !== 0);
}

function getNetBalanceDelta(balanceDelta) {
  if (!balanceDelta) {
    return 0;
  }

  const values = [
    balanceDelta.availableBalance,
    balanceDelta.pendingBalance,
    balanceDelta.outstandingBalance,
  ];

  if (!values.every(Number.isSafeInteger)) {
    return NaN;
  }

  // BigInt avoids intermediate safe-integer overflow.
  return Number(values.reduce((total, value) => total + BigInt(value), 0n));
}

function getStoredTransactionValue(document, path) {
  return path.split(".").reduce((value, key) => value?.[key], document);
}

function normalizeProtectedTransactionValue(value) {
  if (value == null) {
    return null;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (value?._bsontype === "ObjectId" || value?._bsontype === "ObjectID") {
    return String(value);
  }

  return value;
}

function sameProtectedTransactionValue(left, right) {
  return normalizeProtectedTransactionValue(left) === normalizeProtectedTransactionValue(right);
}

function assertProtectedTransactionField(document, previous, path) {
  if (
    !sameProtectedTransactionValue(document.get(path), getStoredTransactionValue(previous, path))
  ) {
    throw new Error(`Established Transaction field ${path} cannot be changed.`);
  }
}

function assertProtectedTransactionWriteOnce(document, previous, path) {
  if (getStoredTransactionValue(previous, path) != null) {
    assertProtectedTransactionField(document, previous, path);
  }
}

function assertProtectedTransactionBalances(document, previous) {
  for (const snapshot of ["balanceBefore", "balanceAfter", "balanceDelta"]) {
    for (const field of ["availableBalance", "pendingBalance", "outstandingBalance"]) {
      assertProtectedTransactionField(document, previous, `${snapshot}.${field}`);
    }
  }
}

function assertActiveFinancialTransaction(session) {
  if (!session || typeof session.inTransaction !== "function" || !session.inTransaction()) {
    throw new Error("Protected financial writes require an active transaction.");
  }
}

function isExactTransactionIdentifier(value) {
  return (
    (typeof value === "string" && value.trim().length > 0 && value === value.trim()) ||
    value?._bsontype === "ObjectId" ||
    value?._bsontype === "ObjectID"
  );
}

module.exports = {
  sameId,
  hasAnyNonZeroBalanceDelta,
  getNetBalanceDelta,
  getStoredTransactionValue,
  normalizeProtectedTransactionValue,
  sameProtectedTransactionValue,
  assertProtectedTransactionField,
  assertProtectedTransactionWriteOnce,
  assertProtectedTransactionBalances,
  assertActiveFinancialTransaction,
  isExactTransactionIdentifier,
};
