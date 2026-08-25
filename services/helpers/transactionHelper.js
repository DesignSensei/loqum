// services/helpers/transactionHelper.js

const mongoose = require("mongoose");

exports.runWithOptionalTransaction = async function runWithOptionalTransaction(
  options = {},
  callback
) {
  if (typeof callback !== "function") {
    throw new TypeError("A transaction callback is required.");
  }

  if (options.session) {
    return callback(options.session);
  }

  const session = await mongoose.startSession();

  try {
    let result;

    await session.withTransaction(async () => {
      result = await callback(session);
    });

    return result;
  } finally {
    await session.endSession();
  }
};
