// utils/dateTime.js

/* ---------- Convert value to valid Date ---------- */
exports.toDate = (value, fieldName = "date") => {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${fieldName}`);
  }

  return date;
};

/* ---------- Calculate hours between two times ---------- */
exports.calculateHoursBetween = (startTime, endTime) => {
  const start = exports.toDate(startTime, "start time");
  const end = exports.toDate(endTime, "end time");

  if (end <= start) {
    throw new Error("End time must be after start time");
  }

  const milliseconds = end.getTime() - start.getTime();
  const hours = milliseconds / (1000 * 60 * 60);

  return Math.round((hours + Number.EPSILON) * 100) / 100;
};

/* ---------- Add minutes to a date ---------- */
exports.addMinutes = (dateValue, minutes) => {
  const date = exports.toDate(dateValue);
  const numericMinutes = Number(minutes);

  if (!Number.isFinite(numericMinutes)) {
    throw new Error("Invalid minutes value");
  }

  return new Date(date.getTime() + numericMinutes * 60 * 1000);
};

/* ---------- Subtract minutes from a date ---------- */
exports.subtractMinutes = (dateValue, minutes) => {
  const date = exports.toDate(dateValue);
  const numericMinutes = Number(minutes);

  if (!Number.isFinite(numericMinutes)) {
    throw new Error("Invalid minutes value");
  }

  return new Date(date.getTime() - numericMinutes * 60 * 1000);
};

/* ---------- Add hours to a date ---------- */
exports.addHours = (dateValue, hours) => {
  const date = exports.toDate(dateValue);
  const numericHours = Number(hours);

  if (!Number.isFinite(numericHours)) {
    throw new Error("Invalid hours value");
  }

  return new Date(date.getTime() + numericHours * 60 * 60 * 1000);
};

/* ---------- Check if check-in PIN should be visible ---------- */
exports.isWithinPinVisibilityWindow = ({ shiftStartTime, visibilityMinutes, now = new Date() }) => {
  const start = exports.toDate(shiftStartTime, "shift start time");
  const currentTime = exports.toDate(now, "current time");

  const visibleFrom = exports.subtractMinutes(start, visibilityMinutes);

  return currentTime >= visibleFrom;
};

/* ---------- Check if no-show grace period has passed ---------- */
exports.hasNoShowGracePassed = ({ shiftStartTime, graceMinutes, now = new Date() }) => {
  const start = exports.toDate(shiftStartTime, "shift start time");
  const currentTime = exports.toDate(now, "current time");

  const graceEndsAt = exports.addMinutes(start, graceMinutes);

  return currentTime > graceEndsAt;
};

/* ---------- Calculate overtime response deadline ---------- */
exports.calculateOvertimeResponseDeadline = ({
  requestedAt = new Date(),
  overtimeResponseHours,
}) => {
  return exports.addHours(requestedAt, overtimeResponseHours);
};
