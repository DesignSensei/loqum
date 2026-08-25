// constants/shiftSettlement.js

/**
 * SHIFT SETTLEMENT CONSTANTS
 *
 * This file defines the shared vocabulary for PROFESSIONAL settlement.
 *
 * IMPORTANT
 *
 * Settlement components describe professional-pay obligations only.
 *
 * They do not describe Loqum platform-fee earning or collection.
 *
 * Platform fees have their own lifecycle and are handled separately from
 * ShiftSettlementBatch.
 *
 * Current professional settlement components:
 *
 * - base
 * - overtime
 *
 * CHALLENGE SCOPE
 *
 * A claim or dispute does not create a "held" settlement status.
 *
 * Settlement blocking is determined from:
 *
 * - the occurrence's remaining ordinary challenge opportunity; and
 * - affectedSettlementComponents on unresolved claim/dispute issues.
 *
 * There is no case-level settlement-component scope authority.
 *
 * Each individual claim/dispute issue owns its own immutable component scope.
 * Live blocking scope is derived from unresolved issues only.
 *
 * OVERTIME
 *
 * Overtime has its own dedicated request, employer review, appeal, admin
 * decision and funding lifecycle.
 *
 * Ordinary claim/dispute vocabulary must not recreate an overtime challenge
 * path.
 */

/* ─────────────────────────────── BATCH STATUSES ─────────────────────────────── */

/**
 * Professional payout batch lifecycle.
 *
 * scheduled
 * -> batch has been created and is waiting for its payout cycle.
 *
 * processing
 * -> the batch is currently being executed.
 *
 * released
 * -> professional payout completed successfully.
 *
 * failed
 * -> the latest execution attempt failed.
 *
 *    The same batch retains its releaseKeys and may be retried.
 *    Therefore failed is not a terminal batch state.
 *
 * cancelled
 * -> the batch was intentionally abandoned before successful payout.
 *
 *    Its occurrence-component releaseKeys are surrendered so those
 *    obligations may be batched again.
 */
exports.SETTLEMENT_BATCH_STATUSES = Object.freeze([
  "scheduled",
  "processing",
  "released",
  "failed",
  "cancelled",
]);

/**
 * States in which a batch currently has active execution work.
 */
exports.ACTIVE_SETTLEMENT_BATCH_STATUSES = Object.freeze(["scheduled", "processing"]);

/**
 * States from which the SAME batch may enter processing.
 *
 * failed batches are retried rather than replaced.
 */
exports.RETRYABLE_SETTLEMENT_BATCH_STATUSES = Object.freeze(["scheduled", "failed"]);

/**
 * Final batch outcomes.
 *
 * failed is deliberately excluded because it remains retryable.
 */
exports.TERMINAL_SETTLEMENT_BATCH_STATUSES = Object.freeze(["released", "cancelled"]);

/* ─────────────────────────────── BATCH INITIATORS ─────────────────────────────── */

exports.SETTLEMENT_BATCH_INITIATOR_ROLES = Object.freeze(["system", "admin"]);

/* ─────────────────────────────── PAYOUT POLICY DEFAULTS ─────────────────────────────── */

/**
 * JavaScript weekday numbering:
 *
 * Sunday = 0
 * Monday = 1
 * ...
 * Saturday = 6
 */
exports.DEFAULT_SETTLEMENT_PAYOUT_WEEKDAY = 1;

/* ─────────────────────────────── FIELD LIMITS ─────────────────────────────── */

exports.MAX_SETTLEMENT_TIME_ZONE_LENGTH = 100;

exports.MAX_SETTLEMENT_BATCH_FAILURE_REASON_LENGTH = 500;

exports.MAX_SETTLEMENT_BATCH_CANCELLATION_REASON_LENGTH = 500;

/* ─────────────────────────────── COMPONENT STATUSES ─────────────────────────────── */

/**
 * Authoritative professional payout lifecycle for one occurrence component.
 *
 * not_due
 * -> no professional payout obligation is currently established for the
 *    component.
 *
 * approved_for_release
 * -> professional pay has been finalized and all current release conditions
 *    have been satisfied.
 *
 *    The component may enter its scheduled payout batch.
 *
 * release_pending
 * -> the component has been reserved into a ShiftSettlementBatch.
 *
 * released
 * -> professional payout for the component completed successfully.
 *
 * There is deliberately no:
 *
 * - held
 * - withheld
 *
 * An ordinary challenge prevents a component from advancing rather than
 * changing it to a separate hold status.
 */
exports.SETTLEMENT_COMPONENT_STATUSES = Object.freeze([
  "not_due",
  "approved_for_release",
  "release_pending",
  "released",
]);

/**
 * States representing an established professional payout obligation.
 */
exports.ESTABLISHED_SETTLEMENT_COMPONENT_STATUSES = Object.freeze([
  "approved_for_release",
  "release_pending",
  "released",
]);

/* ─────────────────────────────── SETTLEMENT COMPONENTS ─────────────────────────────── */

/**
 * Independently releasable professional-pay components of one
 * ShiftOccurrence.
 *
 * Platform fees are not settlement components.
 */
exports.SETTLEMENT_BATCH_COMPONENTS = Object.freeze(["base", "overtime"]);

/* ─────────────────────────────── EARNING TYPES ─────────────────────────────── */

/**
 * Earning type explains why professional pay exists inside a component.
 *
 * BASE:
 *
 * - worked_base
 * - cancellation_compensation
 * - active_work_cancellation
 *
 * OVERTIME:
 *
 * - overtime
 */
const BASE_SETTLEMENT_EARNING_TYPES = Object.freeze([
  "worked_base",
  "cancellation_compensation",
  "active_work_cancellation",
]);

const OVERTIME_SETTLEMENT_EARNING_TYPES = Object.freeze(["overtime"]);

exports.BASE_SETTLEMENT_EARNING_TYPES = BASE_SETTLEMENT_EARNING_TYPES;

exports.OVERTIME_SETTLEMENT_EARNING_TYPES = OVERTIME_SETTLEMENT_EARNING_TYPES;

exports.SETTLEMENT_LINE_EARNING_TYPES = Object.freeze([
  ...BASE_SETTLEMENT_EARNING_TYPES,
  ...OVERTIME_SETTLEMENT_EARNING_TYPES,
]);

/**
 * Explicit component -> earning-type contract.
 *
 * This avoids settlement services and models maintaining their own duplicate
 * earning-type mappings.
 */
exports.SETTLEMENT_EARNING_TYPES_BY_COMPONENT = Object.freeze({
  base: BASE_SETTLEMENT_EARNING_TYPES,

  overtime: OVERTIME_SETTLEMENT_EARNING_TYPES,
});
