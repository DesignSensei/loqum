// scripts/testFacilityPermitActivation.js

require("dotenv").config();

const mongoose = require("mongoose");

const FacilityPermitActivationScheduler = require("../../../jobs/facilityPermitActivationScheduler");

async function main() {
  const mongoUri = process.env.MONGO_URI_TEST;

  if (!mongoUri) {
    throw new Error("MONGO_URI_TEST is required.");
  }

  await mongoose.connect(mongoUri);

  const databaseName = mongoose.connection.db.databaseName;

  console.log("Connected database:", databaseName);

  if (databaseName !== "loqum_test") {
    throw new Error(`Unsafe test database: ${databaseName}. Expected loqum_test.`);
  }

  try {
    const result = await FacilityPermitActivationScheduler.runOnce({
      limit: 10,
      leaseTtlMs: 15 * 60 * 1000,
    });

    console.log("Facility permit scheduler result:", JSON.stringify(result, null, 2));

    if (result.failed || result.skipped) {
      throw new Error(`Scheduler did not complete: ${result.errorMessage || result.reason}`);
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
