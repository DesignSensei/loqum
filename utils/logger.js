const { createLogger, format, transports } = require("winston");
const path = require("path");

// Determine log level: DEBUG during development, INFO otherwise
const level = process.env.NODE_ENV === "production" ? "info" : "debug";

// Define the Console Format
const consoleFormat = format.combine(
  // Add a timestamp
  format.timestamp({ format: "HH:mm:ss" }),
  // Define the message format
  format.printf(({ timestamp, level, message, ...meta }) => {
    const metaString = Object.keys(meta).length ? JSON.stringify(meta) : "";
    return `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${message} ${metaString}`;
  }),
  // Colorize console output
  format.colorize({ all: true })
);

// Define File Format  (for Storage)
const fileFormat = format.combine(
  format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  format.json()
);

const logger = createLogger({
  level,
  transports: [
    // Console transport (always show up in your terminal)
    new transports.Console({ format: consoleFormat }),

    // File transport for all logs (rotates daily)
    new transports.File({
      filename: path.join("logs", "combined.log"),
      format: fileFormat,
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),

    // File transport for errors only
    new transports.File({
      filename: path.join("logs", "error.log"),
      level: "error",
      format: fileFormat,
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
  ],
  exitOnError: false,
});

module.exports = logger;
