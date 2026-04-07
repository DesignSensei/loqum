// config/db.js

const mongoose = require("mongoose");
const logger = require("../utils/logger");

const connectDB = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  logger.info("Connected to MongoDB");
};

module.exports = connectDB;
