// services/shifts/shiftScheduleService.js

const ShiftPricingService = require("./shiftPricingService");

const {
  SHIFT_TIME_ZONE,
  MAX_SHIFT_OCCURRENCES,
  MINUTES_PER_DAY,
  MILLISECONDS_PER_MINUTE,
  MILLISECONDS_PER_DAY,
  MAX_GENERATION_LOOKAHEAD_DAYS,
  SCHEDULE_MODE_OPTIONS,
  REPEAT_DAY_OPTIONS,
} = require("../../constants/shiftPosting");

const { createServiceError } = require("../helpers/serviceErrorHelper");

const { normalizeFieldCode } = require("../helpers/serviceValidationHelpers");

const SHIFT_SERVICE_ERROR_NAME = "ShiftServiceError";

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const LOCAL_TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

const LOCAL_DATE_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/;

function createShiftError(options) {
  return createServiceError({
    ...options,
    name: SHIFT_SERVICE_ERROR_NAME,
  });
}

/**
 * Builds the shared work-date schedule for ONE position.
 * occurrenceCount and aggregatePricing cover dates, not staffing headcount.
 * ShiftCreationService expands these blueprints across positions.
 * platformFeeRate is the applied BASE rate supplied by the creation boundary;
 * this service does not resolve subscription benefits or calculate overtime.
 */
class ShiftScheduleService {
  /* ─────────────────────────────── PUBLIC CONFIGURATION ─────────────────────────────── */

  static getScheduleModeOptions() {
    return SCHEDULE_MODE_OPTIONS.map((option) => ({
      ...option,
    }));
  }

  static getRepeatDayOptions() {
    return REPEAT_DAY_OPTIONS.map((option) => ({
      ...option,
    }));
  }

  static getMaximumOccurrenceCount() {
    return MAX_SHIFT_OCCURRENCES;
  }

  static getTimeZone() {
    return SHIFT_TIME_ZONE;
  }

  /* ─────────────────────────────── INPUT NORMALIZATION ─────────────────────────────── */

  static normalizeScheduleMode(value) {
    const scheduleMode = String(value || "single")
      .trim()
      .toLowerCase();

    const isAllowed = SCHEDULE_MODE_OPTIONS.some((option) => option.value === scheduleMode);

    if (!isAllowed) {
      throw createShiftError({
        message: "Schedule mode must be single or multiple.",
        code: "INVALID_SCHEDULE_MODE",
      });
    }

    return scheduleMode;
  }

  static normalizeBoolean(value, fieldName, defaultValue = false) {
    if (value === null || value === undefined || value === "") {
      return defaultValue;
    }

    if (typeof value === "boolean") {
      return value;
    }

    if (typeof value === "number") {
      if (value === 1) {
        return true;
      }

      if (value === 0) {
        return false;
      }
    }

    const normalizedValue = String(value).trim().toLowerCase();

    if (["true", "1", "yes", "on"].includes(normalizedValue)) {
      return true;
    }

    if (["false", "0", "no", "off"].includes(normalizedValue)) {
      return false;
    }

    throw createShiftError({
      message: `${fieldName} must be true or false.`,
      code: `INVALID_${normalizeFieldCode(fieldName)}`,
    });
  }

  static parseInteger(value, fieldName) {
    if (
      !["number", "string"].includes(typeof value) ||
      (typeof value === "string" && !/^-?\d+$/.test(value.trim())) ||
      !Number.isSafeInteger(Number(value))
    ) {
      throw createShiftError({
        message: `${fieldName} must be a whole number.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
      });
    }
    return Number(value);
  }

  static normalizeOccurrenceCount(value, scheduleMode) {
    if (scheduleMode === "single") {
      if (value === null || value === undefined || value === "") {
        return 1;
      }

      const occurrenceCount = ShiftScheduleService.parseInteger(value, "occurrenceCount");

      if (!Number.isSafeInteger(occurrenceCount) || occurrenceCount !== 1) {
        throw createShiftError({
          message: "A single shift must contain exactly one occurrence.",
          code: "INVALID_SINGLE_SHIFT_OCCURRENCE_COUNT",
        });
      }

      return 1;
    }

    if (scheduleMode !== "multiple") {
      throw createShiftError({
        message: "Schedule mode must be single or multiple.",
        code: "INVALID_SCHEDULE_MODE",
      });
    }

    const occurrenceCount = ShiftScheduleService.parseInteger(value, "occurrenceCount");

    if (
      !Number.isSafeInteger(occurrenceCount) ||
      occurrenceCount < 2 ||
      occurrenceCount > MAX_SHIFT_OCCURRENCES
    ) {
      throw createShiftError({
        message: "Number of shifts must be between " + `2 and ${MAX_SHIFT_OCCURRENCES}.`,
        code: "INVALID_OCCURRENCE_COUNT",
      });
    }

    return occurrenceCount;
  }

  static normalizeRepeatDays(value, scheduleMode) {
    if (scheduleMode === "single") {
      if (
        value === null ||
        value === undefined ||
        value === "" ||
        (Array.isArray(value) && value.length === 0)
      ) {
        return [];
      }

      throw createShiftError({
        message: "A single shift cannot contain repeat days.",
        code: "SINGLE_SHIFT_REPEAT_DAYS_NOT_ALLOWED",
      });
    }

    if (scheduleMode !== "multiple") {
      throw createShiftError({
        message: "Schedule mode must be single or multiple.",
        code: "INVALID_SCHEDULE_MODE",
      });
    }

    const rawValues = Array.isArray(value)
      ? value
      : String(value ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);

    if (rawValues.length === 0) {
      throw createShiftError({
        message: "Select at least one repeat day.",
        code: "REPEAT_DAYS_REQUIRED",
      });
    }

    const seenDays = new Set();

    for (const rawValue of rawValues) {
      const day = ShiftScheduleService.parseInteger(rawValue, "repeatDay");

      if (!Number.isSafeInteger(day) || day < 0 || day > 6) {
        throw createShiftError({
          message: "Each repeat day must be a whole number from 0 to 6.",
          code: "INVALID_REPEAT_DAY",
        });
      }

      seenDays.add(day);
    }

    return REPEAT_DAY_OPTIONS.map((option) => option.value).filter((day) => seenDays.has(day));
  }

  static parseBreakDuration(value) {
    if (value === null || value === undefined || value === "") {
      return 0;
    }

    const breakDuration = ShiftScheduleService.parseInteger(value, "breakDuration");

    if (
      !Number.isSafeInteger(breakDuration) ||
      breakDuration < 0 ||
      breakDuration > MINUTES_PER_DAY
    ) {
      throw createShiftError({
        message: "Break duration must be a whole number from 0 to 1,440 minutes.",
        code: "INVALID_BREAK_DURATION",
      });
    }

    return breakDuration;
  }

  /* ─────────────────────────────── LOCAL DATE / TIME ─────────────────────────────── */

  static parseDate(value, fieldName) {
    const fieldCode = normalizeFieldCode(fieldName);
    if (value instanceof Date) {
      return ShiftScheduleService.assertWholeMinuteDate(value, fieldName);
    }

    const cleanValue = typeof value === "string" ? value.trim() : "";
    if (!cleanValue) {
      throw createShiftError({
        message: `${fieldName} is required.`,
        code: `REQUIRED_${fieldCode}`,
      });
    }

    const localMatch = cleanValue.match(LOCAL_DATE_TIME_PATTERN);
    if (localMatch) {
      if (Number(localMatch[3] || 0) !== 0) {
        throw createShiftError({
          message: `${fieldName} must be specified in whole minutes.`,
          code: `INVALID_${fieldCode}`,
        });
      }
      return ShiftScheduleService.buildDateTimeFromLocalSchedule({
        localDate: ShiftScheduleService.normalizeLocalDate(localMatch[1], fieldName),
        timeMinutes: ShiftScheduleService.parseLocalTimeMinutes(localMatch[2], fieldName),
        timeZone: SHIFT_TIME_ZONE,
      });
    }

    // Offset-bearing ISO input is unambiguous; other formats must not fall
    // through to host-timezone-dependent or lenient JavaScript date parsing.
    const isoMatch = cleanValue.match(
      /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/
    );
    if (!isoMatch) {
      throw createShiftError({
        message: `${fieldName} must be a local YYYY-MM-DDTHH:mm time or an ISO timestamp with an explicit offset.`,
        code: `INVALID_${fieldCode}`,
      });
    }

    ShiftScheduleService.normalizeLocalDate(isoMatch[1], fieldName);
    ShiftScheduleService.parseLocalTimeMinutes(isoMatch[2], fieldName);
    if (Number(isoMatch[3] || 0) !== 0 || Number(isoMatch[4] || 0) !== 0) {
      throw createShiftError({
        message: `${fieldName} must be specified in whole minutes.`,
        code: `INVALID_${fieldCode}`,
      });
    }
    return ShiftScheduleService.assertWholeMinuteDate(new Date(cleanValue), fieldName);
  }

  static assertWholeMinuteDate(value, fieldName) {
    const date = new Date(value.getTime());
    if (!Number.isFinite(date.getTime()) || date.getTime() % MILLISECONDS_PER_MINUTE !== 0) {
      throw createShiftError({
        message: `${fieldName} must be a valid date and time specified in whole minutes.`,
        code: `INVALID_${normalizeFieldCode(fieldName)}`,
      });
    }
    return date;
  }

  static normalizeLocalDate(value, fieldName) {
    let cleanValue = String(value ?? "").trim();

    const fieldCode = normalizeFieldCode(fieldName);

    const dateTimeMatch = cleanValue.match(LOCAL_DATE_TIME_PATTERN);

    if (dateTimeMatch) {
      cleanValue = dateTimeMatch[1];
    }

    if (!LOCAL_DATE_PATTERN.test(cleanValue)) {
      throw createShiftError({
        message: `${fieldName} must use YYYY-MM-DD format.`,
        code: `INVALID_${fieldCode}`,
      });
    }

    const [year, month, day] = cleanValue.split("-").map(Number);

    const parsedDate = new Date(Date.UTC(year, month - 1, day));

    const isValidDate =
      parsedDate.getUTCFullYear() === year &&
      parsedDate.getUTCMonth() === month - 1 &&
      parsedDate.getUTCDate() === day;

    if (!isValidDate) {
      throw createShiftError({
        message: `${fieldName} must be a valid calendar date.`,
        code: `INVALID_${fieldCode}`,
      });
    }

    return cleanValue;
  }

  static parseLocalTimeMinutes(value, fieldName) {
    let cleanValue = String(value ?? "").trim();

    const fieldCode = normalizeFieldCode(fieldName);

    const dateTimeMatch = cleanValue.match(LOCAL_DATE_TIME_PATTERN);

    if (dateTimeMatch) {
      const dateTimeSecond = Number(dateTimeMatch[3] || 0);

      if (dateTimeSecond !== 0) {
        throw createShiftError({
          message: `${fieldName} must be specified in whole minutes.`,
          code: `INVALID_${fieldCode}`,
        });
      }

      cleanValue = dateTimeMatch[2];
    }

    const timeMatch = cleanValue.match(LOCAL_TIME_PATTERN);

    if (!timeMatch) {
      throw createShiftError({
        message: `${fieldName} must be a valid time in HH:mm format.`,
        code: `INVALID_${fieldCode}`,
      });
    }

    const hour = Number(timeMatch[1]);

    const minute = Number(timeMatch[2]);

    const second = Number(timeMatch[3] || 0);

    if (
      !Number.isSafeInteger(hour) ||
      !Number.isSafeInteger(minute) ||
      !Number.isSafeInteger(second) ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59 ||
      second !== 0
    ) {
      throw createShiftError({
        message: `${fieldName} must be a valid whole-minute time.`,
        code: `INVALID_${fieldCode}`,
      });
    }

    return hour * 60 + minute;
  }

  static padNumber(value, width = 2) {
    return String(value).padStart(width, "0");
  }

  static getLocalDateParts(localDate) {
    const normalizedDate = ShiftScheduleService.normalizeLocalDate(localDate, "localDate");

    const [year, month, day] = normalizedDate.split("-").map(Number);

    return {
      year,
      month,
      day,
    };
  }

  static addDaysToLocalDate(localDate, daysToAdd) {
    const { year, month, day } = ShiftScheduleService.getLocalDateParts(localDate);

    const normalizedDaysToAdd = ShiftScheduleService.parseInteger(daysToAdd, "daysToAdd");

    if (!Number.isSafeInteger(normalizedDaysToAdd)) {
      throw createShiftError({
        message: "Days to add must be a whole number.",
        code: "INVALID_DAYS_TO_ADD",
        statusCode: 500,
      });
    }

    const date = new Date(
      Date.UTC(year, month - 1, day) + normalizedDaysToAdd * MILLISECONDS_PER_DAY
    );

    return [
      date.getUTCFullYear(),

      ShiftScheduleService.padNumber(date.getUTCMonth() + 1),

      ShiftScheduleService.padNumber(date.getUTCDate()),
    ].join("-");
  }

  static getWeekdayForLocalDate(localDate) {
    const { year, month, day } = ShiftScheduleService.getLocalDateParts(localDate);

    return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  }

  static formatTimeMinutes(timeMinutes) {
    const normalizedMinutes = Number(timeMinutes);

    if (
      !Number.isSafeInteger(normalizedMinutes) ||
      normalizedMinutes < 0 ||
      normalizedMinutes >= MINUTES_PER_DAY
    ) {
      throw createShiftError({
        message: "Time minutes are invalid.",
        code: "INVALID_TIME_MINUTES",
        statusCode: 500,
      });
    }

    const hour = Math.floor(normalizedMinutes / 60);

    const minute = normalizedMinutes % 60;

    return `${ShiftScheduleService.padNumber(hour)}:` + ShiftScheduleService.padNumber(minute);
  }

  static getTimeZoneOffsetMilliseconds(date, timeZone) {
    const parsedDate = new Date(date);

    if (Number.isNaN(parsedDate.getTime())) {
      throw createShiftError({
        message: "A valid date is required to resolve the timezone offset.",
        code: "INVALID_TIME_ZONE_OFFSET_DATE",
        statusCode: 500,
      });
    }

    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,

      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",

      hourCycle: "h23",
    }).formatToParts(parsedDate);

    const partMap = Object.fromEntries(
      parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
    );

    const representedAsUtc = Date.UTC(
      Number(partMap.year),
      Number(partMap.month) - 1,
      Number(partMap.day),
      Number(partMap.hour),
      Number(partMap.minute),
      Number(partMap.second)
    );

    return representedAsUtc - parsedDate.getTime();
  }

  static buildDateTimeFromLocalSchedule({
    localDate,
    timeMinutes,
    daysToAdd = 0,
    timeZone = SHIFT_TIME_ZONE,
  }) {
    const adjustedDate = ShiftScheduleService.addDaysToLocalDate(localDate, daysToAdd);

    const { year, month, day } = ShiftScheduleService.getLocalDateParts(adjustedDate);

    const normalizedMinutes = Number(timeMinutes);

    if (
      !Number.isSafeInteger(normalizedMinutes) ||
      normalizedMinutes < 0 ||
      normalizedMinutes >= MINUTES_PER_DAY
    ) {
      throw createShiftError({
        message: "The generated Shift time is invalid.",
        code: "INVALID_GENERATED_SHIFT_TIME",
        statusCode: 500,
      });
    }

    const hour = Math.floor(normalizedMinutes / 60);

    const minute = normalizedMinutes % 60;

    const localWallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

    const firstGuess = new Date(localWallClockAsUtc);

    const firstOffset = ShiftScheduleService.getTimeZoneOffsetMilliseconds(firstGuess, timeZone);

    let parsedDate = new Date(localWallClockAsUtc - firstOffset);

    const resolvedOffset = ShiftScheduleService.getTimeZoneOffsetMilliseconds(parsedDate, timeZone);

    if (resolvedOffset !== firstOffset) {
      parsedDate = new Date(localWallClockAsUtc - resolvedOffset);
    }

    const resolvedParts = new Intl.DateTimeFormat("en-US", {
      timeZone,

      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",

      hourCycle: "h23",
    }).formatToParts(parsedDate);

    const resolvedPartMap = Object.fromEntries(
      resolvedParts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
    );

    const resolvedLocalDate = [
      resolvedPartMap.year,
      resolvedPartMap.month,
      resolvedPartMap.day,
    ].join("-");

    const resolvedTimeMinutes = Number(resolvedPartMap.hour) * 60 + Number(resolvedPartMap.minute);

    if (resolvedLocalDate !== adjustedDate || resolvedTimeMinutes !== normalizedMinutes) {
      throw createShiftError({
        message: "The selected local date and time does not exist in the configured timezone.",
        code: "INVALID_LOCAL_SHIFT_DATE_TIME",
      });
    }

    return parsedDate;
  }

  static extractLocalDateTimeParts(date) {
    const parsedDate = new Date(date);

    if (Number.isNaN(parsedDate.getTime())) {
      throw createShiftError({
        message: "A valid date is required.",
        code: "INVALID_DATE",
        statusCode: 500,
      });
    }

    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: SHIFT_TIME_ZONE,

      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",

      hourCycle: "h23",
    }).formatToParts(parsedDate);

    const partMap = Object.fromEntries(
      parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
    );

    const year = Number(partMap.year);

    const month = Number(partMap.month);

    const day = Number(partMap.day);

    const hour = Number(partMap.hour);

    const minute = Number(partMap.minute);

    return {
      localDate: [
        ShiftScheduleService.padNumber(year, 4),

        ShiftScheduleService.padNumber(month),

        ShiftScheduleService.padNumber(day),
      ].join("-"),

      timeMinutes: hour * 60 + minute,
    };
  }

  /* ─────────────────────────────── OCCURRENCE GENERATION ─────────────────────────────── */

  static calculatePatternScheduledMinutes({
    dailyStartTimeMinutes,
    dailyEndTimeMinutes,
    endsNextDay,
  }) {
    let scheduledMinutes;

    if (endsNextDay) {
      scheduledMinutes = MINUTES_PER_DAY - dailyStartTimeMinutes + dailyEndTimeMinutes;
    } else {
      scheduledMinutes = dailyEndTimeMinutes - dailyStartTimeMinutes;
    }

    if (
      !Number.isSafeInteger(scheduledMinutes) ||
      scheduledMinutes <= 0 ||
      scheduledMinutes > MINUTES_PER_DAY
    ) {
      throw createShiftError({
        message:
          "Each shift must last between 1 minute and 24 hours. Select ‘Ends next day’ for overnight or 24-hour shifts.",
        code: "INVALID_REPEATED_SHIFT_DURATION",
      });
    }

    return scheduledMinutes;
  }

  static generateOccurrenceDates({ firstOccurrenceDate, repeatDays, occurrenceCount }) {
    if (!Array.isArray(repeatDays) || repeatDays.length === 0) {
      throw createShiftError({
        message: "Select at least one repeat day.",
        code: "REPEAT_DAYS_REQUIRED",
      });
    }

    if (
      !Number.isSafeInteger(occurrenceCount) ||
      occurrenceCount < 1 ||
      occurrenceCount > MAX_SHIFT_OCCURRENCES
    ) {
      throw createShiftError({
        message: "Occurrence count must be a positive whole number.",
        code: "INVALID_OCCURRENCE_COUNT",
      });
    }

    repeatDays = ShiftScheduleService.normalizeRepeatDays(repeatDays, "multiple");
    firstOccurrenceDate = ShiftScheduleService.normalizeLocalDate(
      firstOccurrenceDate,
      "firstOccurrenceDate"
    );

    const firstWeekday = ShiftScheduleService.getWeekdayForLocalDate(firstOccurrenceDate);

    if (!repeatDays.includes(firstWeekday)) {
      throw createShiftError({
        message: "The first shift date must fall on one of the selected repeat days.",
        code: "FIRST_OCCURRENCE_DAY_NOT_SELECTED",
      });
    }

    const occurrenceDates = [];

    let currentDate = firstOccurrenceDate;

    let inspectedDays = 0;

    while (
      occurrenceDates.length < occurrenceCount &&
      inspectedDays < MAX_GENERATION_LOOKAHEAD_DAYS
    ) {
      const weekday = ShiftScheduleService.getWeekdayForLocalDate(currentDate);
      if (repeatDays.includes(weekday)) {
        occurrenceDates.push(currentDate);
      }
      inspectedDays += 1;
      if (occurrenceDates.length < occurrenceCount) {
        currentDate = ShiftScheduleService.addDaysToLocalDate(currentDate, 1);
      }
    }

    if (occurrenceDates.length !== occurrenceCount) {
      throw createShiftError({
        message:
          "The selected repeat pattern cannot generate the requested work dates within the supported lookahead.",
        code: "SHIFT_OCCURRENCE_GENERATION_LIMIT_EXCEEDED",
      });
    }

    return occurrenceDates;
  }

  static calculateScheduledTime(startTime, endTime) {
    const normalizedStartTime = ShiftScheduleService.parseDate(startTime, "startTime");

    const normalizedEndTime = ShiftScheduleService.parseDate(endTime, "endTime");

    if (Number.isNaN(normalizedStartTime.getTime()) || Number.isNaN(normalizedEndTime.getTime())) {
      throw createShiftError({
        message: "Shift start and end times must be valid dates.",
        code: "INVALID_SHIFT_TIME_RANGE",
      });
    }

    const durationMilliseconds = normalizedEndTime.getTime() - normalizedStartTime.getTime();

    if (durationMilliseconds <= 0) {
      throw createShiftError({
        message: "Shift end time must be later than start time.",
        code: "INVALID_SHIFT_TIME_RANGE",
      });
    }

    if (durationMilliseconds % MILLISECONDS_PER_MINUTE !== 0) {
      throw createShiftError({
        message: "Shift duration must be specified in whole minutes.",
        code: "INVALID_SHIFT_DURATION",
      });
    }

    const scheduledMinutes = durationMilliseconds / MILLISECONDS_PER_MINUTE;

    if (
      !Number.isSafeInteger(scheduledMinutes) ||
      scheduledMinutes <= 0 ||
      scheduledMinutes > MINUTES_PER_DAY
    ) {
      throw createShiftError({
        message: "A shift must last between 1 minute and 24 hours.",
        code: "INVALID_SHIFT_DURATION",
      });
    }

    return {
      scheduledMinutes,

      scheduledHours: scheduledMinutes / 60,
    };
  }

  /* ─────────────────────────────── SCHEDULE BUILDERS ─────────────────────────────── */

  static buildSingleSchedule({
    shiftData,
    hourlyRate,
    platformFeeRate,
    breakDuration,
    currentTime = new Date(),
  }) {
    ShiftScheduleService.assertShiftData(shiftData);
    ShiftScheduleService.normalizeOccurrenceCount(shiftData.occurrenceCount, "single");
    ShiftScheduleService.normalizeRepeatDays(shiftData.repeatDays, "single");
    breakDuration = ShiftScheduleService.parseBreakDuration(breakDuration);

    const startTime = ShiftScheduleService.parseDate(shiftData.startTime, "startTime");

    const endTime = ShiftScheduleService.parseDate(shiftData.endTime, "endTime");

    const normalizedCurrentTime = new Date(currentTime);

    if (Number.isNaN(normalizedCurrentTime.getTime())) {
      throw createShiftError({
        message: "The current time is invalid.",
        code: "INVALID_CURRENT_TIME",
        statusCode: 500,
      });
    }

    if (startTime <= normalizedCurrentTime) {
      throw createShiftError({
        message: "Shift start time must be in the future.",
        code: "SHIFT_START_TIME_NOT_IN_FUTURE",
      });
    }

    const { scheduledMinutes, scheduledHours } = ShiftScheduleService.calculateScheduledTime(
      startTime,
      endTime
    );

    if (breakDuration >= scheduledMinutes) {
      throw createShiftError({
        message: "Break duration must be shorter than the shift duration.",
        code: "BREAK_DURATION_EXCEEDS_SHIFT",
      });
    }

    const startParts = ShiftScheduleService.extractLocalDateTimeParts(startTime);

    const endParts = ShiftScheduleService.extractLocalDateTimeParts(endTime);

    const endsNextDay = endParts.localDate !== startParts.localDate;

    const pricing = ShiftPricingService.calculateShiftPricing({
      hourlyRate,
      scheduledMinutes,
      platformFeeRate,
    });

    const occurrenceBlueprint = {
      sequenceNumber: 1,

      occurrenceDate: startParts.localDate,

      scheduleTimeZone: SHIFT_TIME_ZONE,

      startTime,

      endTime,

      scheduledMinutes,

      scheduledHours,

      breakDuration,

      hourlyRate,

      platformFeeRate,

      ...pricing,
    };

    return {
      scheduleMode: "single",

      occurrenceCount: 1,

      repeatDays: [],

      firstOccurrenceDate: startParts.localDate,

      lastOccurrenceDate: startParts.localDate,

      scheduleTimeZone: SHIFT_TIME_ZONE,

      dailyStartTimeMinutes: startParts.timeMinutes,

      dailyEndTimeMinutes: endParts.timeMinutes,

      endsNextDay,

      scheduledMinutesPerOccurrence: scheduledMinutes,

      totalScheduledMinutes: scheduledMinutes,

      scheduledHours,

      startTime,

      endTime,

      occurrenceBlueprints: [occurrenceBlueprint],
    };
  }

  static buildMultipleSchedule({
    shiftData,
    hourlyRate,
    platformFeeRate,
    breakDuration,
    currentTime = new Date(),
  }) {
    ShiftScheduleService.assertShiftData(shiftData);
    breakDuration = ShiftScheduleService.parseBreakDuration(breakDuration);

    const occurrenceCount = ShiftScheduleService.normalizeOccurrenceCount(
      shiftData.occurrenceCount,
      "multiple"
    );

    const repeatDays = ShiftScheduleService.normalizeRepeatDays(shiftData.repeatDays, "multiple");

    const firstOccurrenceDate = ShiftScheduleService.normalizeLocalDate(
      shiftData.firstOccurrenceDate || shiftData.startDate || shiftData.startTime,
      "firstOccurrenceDate"
    );

    const dailyStartTimeMinutes = ShiftScheduleService.parseLocalTimeMinutes(
      shiftData.dailyStartTime || shiftData.startTime,
      "dailyStartTime"
    );

    const dailyEndTimeMinutes = ShiftScheduleService.parseLocalTimeMinutes(
      shiftData.dailyEndTime || shiftData.endTime,
      "dailyEndTime"
    );

    const endsNextDay = ShiftScheduleService.normalizeBoolean(
      shiftData.endsNextDay,
      "endsNextDay",
      false
    );

    const scheduledMinutesPerOccurrence = ShiftScheduleService.calculatePatternScheduledMinutes({
      dailyStartTimeMinutes,
      dailyEndTimeMinutes,
      endsNextDay,
    });

    if (breakDuration >= scheduledMinutesPerOccurrence) {
      throw createShiftError({
        message: "Break duration must be shorter than each shift.",
        code: "BREAK_DURATION_EXCEEDS_SHIFT",
      });
    }

    const occurrenceDates = ShiftScheduleService.generateOccurrenceDates({
      firstOccurrenceDate,
      repeatDays,
      occurrenceCount,
    });

    const normalizedCurrentTime = new Date(currentTime);

    if (Number.isNaN(normalizedCurrentTime.getTime())) {
      throw createShiftError({
        message: "The current time is invalid.",
        code: "INVALID_CURRENT_TIME",
        statusCode: 500,
      });
    }

    const occurrenceBlueprints = occurrenceDates.map((occurrenceDate, index) => {
      const sequenceNumber = index + 1;

      const startTime = ShiftScheduleService.buildDateTimeFromLocalSchedule({
        localDate: occurrenceDate,

        timeMinutes: dailyStartTimeMinutes,
      });

      const endTime = ShiftScheduleService.buildDateTimeFromLocalSchedule({
        localDate: occurrenceDate,

        timeMinutes: dailyEndTimeMinutes,

        daysToAdd: endsNextDay ? 1 : 0,
      });

      if (sequenceNumber === 1 && startTime <= normalizedCurrentTime) {
        throw createShiftError({
          message: "The first shift start time must be in the future.",
          code: "SHIFT_START_TIME_NOT_IN_FUTURE",
        });
      }

      const calculatedTime = ShiftScheduleService.calculateScheduledTime(startTime, endTime);

      if (calculatedTime.scheduledMinutes !== scheduledMinutesPerOccurrence) {
        throw createShiftError({
          message: "The generated shift duration is inconsistent.",
          code: "GENERATED_SHIFT_DURATION_MISMATCH",
          statusCode: 500,
        });
      }

      const pricing = ShiftPricingService.calculateShiftPricing({
        hourlyRate,

        scheduledMinutes: scheduledMinutesPerOccurrence,

        platformFeeRate,
      });

      return {
        sequenceNumber,

        occurrenceDate,

        scheduleTimeZone: SHIFT_TIME_ZONE,

        startTime,

        endTime,

        scheduledMinutes: scheduledMinutesPerOccurrence,

        scheduledHours: scheduledMinutesPerOccurrence / 60,

        breakDuration,

        hourlyRate,

        platformFeeRate,

        ...pricing,
      };
    });

    const totalScheduledMinutes = scheduledMinutesPerOccurrence * occurrenceCount;

    if (!Number.isSafeInteger(totalScheduledMinutes)) {
      throw createShiftError({
        message: "The calculated engagement duration is too large.",
        code: "CALCULATED_ENGAGEMENT_DURATION_TOO_LARGE",
        statusCode: 500,
      });
    }

    const lastOccurrence = occurrenceBlueprints[occurrenceBlueprints.length - 1];

    return {
      scheduleMode: "multiple",

      occurrenceCount,

      repeatDays,

      firstOccurrenceDate: occurrenceBlueprints[0].occurrenceDate,

      lastOccurrenceDate: lastOccurrence.occurrenceDate,

      scheduleTimeZone: SHIFT_TIME_ZONE,

      dailyStartTimeMinutes,

      dailyEndTimeMinutes,

      endsNextDay,

      scheduledMinutesPerOccurrence,

      totalScheduledMinutes,

      scheduledHours: totalScheduledMinutes / 60,

      startTime: occurrenceBlueprints[0].startTime,

      endTime: lastOccurrence.endTime,

      occurrenceBlueprints,
    };
  }

  static assertShiftData(shiftData) {
    if (!shiftData || typeof shiftData !== "object" || Array.isArray(shiftData)) {
      throw createShiftError({
        message: "Shift details are required.",
        code: "SHIFT_DATA_REQUIRED",
      });
    }
  }

  static buildSchedule({
    scheduleMode,
    shiftData,
    hourlyRate,
    platformFeeRate,
    breakDuration,
    currentTime = new Date(),
  }) {
    scheduleMode = ShiftScheduleService.normalizeScheduleMode(scheduleMode);

    if (scheduleMode === "single") {
      const schedule = ShiftScheduleService.buildSingleSchedule({
        shiftData,
        hourlyRate,
        platformFeeRate,
        breakDuration,
        currentTime,
      });

      const occurrencePricing = {
        estimatedProfessionalPay: schedule.occurrenceBlueprints[0].estimatedProfessionalPay,

        estimatedPlatformFee: schedule.occurrenceBlueprints[0].estimatedPlatformFee,

        estimatedEmployerCharge: schedule.occurrenceBlueprints[0].estimatedEmployerCharge,
      };

      return {
        ...schedule,

        occurrencePricing,

        aggregatePricing: {
          ...occurrencePricing,
        },
      };
    }

    if (scheduleMode !== "multiple") {
      throw createShiftError({
        message: "Schedule mode must be single or multiple.",
        code: "INVALID_SCHEDULE_MODE",
      });
    }

    const schedule = ShiftScheduleService.buildMultipleSchedule({
      shiftData,
      hourlyRate,
      platformFeeRate,
      breakDuration,
      currentTime,
    });

    const estimatedProfessionalPay = ShiftPricingService.sumSafeIntegerAmounts(
      schedule.occurrenceBlueprints.map((occurrence) => occurrence.estimatedProfessionalPay),
      "estimated professional pay"
    );

    const estimatedPlatformFee = ShiftPricingService.sumSafeIntegerAmounts(
      schedule.occurrenceBlueprints.map((occurrence) => occurrence.estimatedPlatformFee),
      "estimated platform fee"
    );

    const estimatedEmployerCharge = ShiftPricingService.sumSafeIntegerAmounts(
      schedule.occurrenceBlueprints.map((occurrence) => occurrence.estimatedEmployerCharge),
      "estimated employer charge"
    );

    if (estimatedEmployerCharge !== estimatedProfessionalPay + estimatedPlatformFee) {
      throw createShiftError({
        message: "The calculated engagement pricing is inconsistent.",
        code: "ENGAGEMENT_PRICING_MISMATCH",
        statusCode: 500,
      });
    }

    return {
      ...schedule,

      occurrencePricing: {
        estimatedProfessionalPay: schedule.occurrenceBlueprints[0].estimatedProfessionalPay,

        estimatedPlatformFee: schedule.occurrenceBlueprints[0].estimatedPlatformFee,

        estimatedEmployerCharge: schedule.occurrenceBlueprints[0].estimatedEmployerCharge,
      },

      aggregatePricing: {
        estimatedProfessionalPay,
        estimatedPlatformFee,
        estimatedEmployerCharge,
      },
    };
  }
}

module.exports = ShiftScheduleService;
