// services/helpers/transactionHelper.js

const mongoose = require("mongoose");

function assertActiveTransaction(session) {
  if (!session || typeof session.inTransaction !== "function" || session.inTransaction() !== true) {
    throw new Error("A supplied session must have an active transaction.");
  }
}

exports.runWithOptionalTransaction = async function runWithOptionalTransaction(
  options = {},
  callback
) {
  if (typeof callback !== "function") {
    throw new TypeError("A transaction callback is required.");
  }

  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Transaction options must be an object.");
  }

  if (options.session !== undefined && options.session !== null) {
    assertActiveTransaction(options.session);
    // The caller owns commit, abort, retries and session cleanup.
    return callback(options.session);
  }

  const session = await mongoose.startSession();

  try {
    // The driver may rerun this callback. Keep external provider calls and
    // other non-transactional side effects outside it, and pass the session
    // to every database operation that belongs to the transaction.
    return await session.withTransaction(async () => {
      assertActiveTransaction(session);
      return callback(session);
    });
  } finally {
    await session.endSession();
  }
};
