// models/helpers/dateTimeHelpers.js

const { isValidLocalDateString } = require("./schemaValidators");

function getWeekdayForLocalDate(value) {
  if (!isValidLocalDateString(value)) {
    return null;
  }

  const [year, month, day] = String(value).split("-").map(Number);

  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

module.exports = {
  getWeekdayForLocalDate,
};
