// jobs/facilityPermitActivationScheduler.js

const crypto = require("node:crypto");
const mongoose = require("mongoose");

const FacilityPermitVerificationService = require("../services/facilityPermitVerificationService");

const logger = require("../utils/logger");

const DEFAULT_INTERVAL_MINUTES = 5;
const DEFAULT_PROCESSING_LIMIT = 100;
const MAX_PROCESSING_LIMIT = 1000;
const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000;

const LEASE_COLLECTION = "scheduler_leases";
const LEASE_KEY = "facility_permit_activation";

/**
 * FACILITY PERMIT ACTIVATION SCHEDULER
 *
 * Discovers approved future-dated permits whose validity
 * start date has arrived.
 *
 * Responsibilities:
 * - Bounded candidate discovery.
 * - Preventing overlapping local runs.
 * - Coordinating multiple instances through a MongoDB lease.
 * - Retaining a discovery cursor between runs.
 * - Delegating activation to FacilityPermitVerificationService.
 * - Logging failures without stopping the entire batch.
 *
 * This scheduler must never:
 * - Approve a permit.
 * - Mark a permit as current directly.
 * - Bypass premises or policy checks.
 * - Modify employer verification state.
 *
 * FacilityPermitVerificationService remains authoritative
 * for transactional permit activation.
 */

class FacilityPermitActivationScheduler {
  static intervalHandle = null;
  static isRunning = false;
  static stopping = false;

  // ───────────────────── VALIDATION ─────────────────────

  static positiveInteger(value, name, maximum) {
    const number = Number(value);

    if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
      throw new Error(`Facility permit scheduler ${name} must be between 1 and ${maximum}.`);
    }

    return number;
  }

  static normalizeOptions({
    intervalMinutes = DEFAULT_INTERVAL_MINUTES,
    limit = DEFAULT_PROCESSING_LIMIT,
    leaseTtlMs = DEFAULT_LEASE_TTL_MS,
    runImmediately = false,
  } = {}) {
    if (typeof runImmediately !== "boolean") {
      throw new Error("Facility permit scheduler runImmediately must be a boolean.");
    }

    const normalizedInterval = this.positiveInteger(intervalMinutes, "intervalMinutes", 1440);

    const normalizedLimit = this.positiveInteger(limit, "limit", MAX_PROCESSING_LIMIT);

    const normalizedLease = this.positiveInteger(leaseTtlMs, "leaseTtlMs", 60 * 60 * 1000);

    if (normalizedLease < 2 * 60 * 1000) {
      throw new Error("Facility permit scheduler lease must be at least two minutes.");
    }

    return {
      intervalMinutes: normalizedInterval,
      limit: normalizedLimit,
      leaseTtlMs: normalizedLease,
      runImmediately,
    };
  }

  // ───────────────────── DISTRIBUTED LEASE ─────────────────────

  static leaseCollection() {
    if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
      throw new Error("Facility permit scheduler requires an active MongoDB connection.");
    }

    return mongoose.connection.db.collection(LEASE_COLLECTION);
  }

  /**
   * Atomic acquisition using MongoDB's unique _id index.
   *
   * The lease document also retains the discovery cursor so
   * another application instance can continue after takeover.
   */
  static async acquireLease(leaseTtlMs) {
    const ownerToken = crypto.randomBytes(16).toString("hex");
    const now = new Date();

    try {
      const response = await this.leaseCollection().findOneAndUpdate(
        {
          _id: LEASE_KEY,
          $or: [{ expiresAt: { $lte: now } }, { expiresAt: { $exists: false } }],
        },
        {
          $set: {
            ownerToken,
            acquiredAt: now,
            expiresAt: new Date(now.getTime() + leaseTtlMs),
          },
        },
        {
          upsert: true,
          returnDocument: "after",
        }
      );

      // Support MongoDB driver result shapes.
      const document = response?.value ?? response;

      if (!document || document.ownerToken !== ownerToken) {
        return null;
      }

      return {
        ownerToken,
        cursor: document.cursor || null,
      };
    } catch (error) {
      // Another instance currently owns the lease.
      if (error.code === 11000) {
        return null;
      }

      throw error;
    }
  }

  static async renewLease(ownerToken, leaseTtlMs) {
    const now = new Date();

    const result = await this.leaseCollection().updateOne(
      {
        _id: LEASE_KEY,
        ownerToken,
        expiresAt: { $gt: now },
      },
      {
        $set: {
          renewedAt: now,
          expiresAt: new Date(now.getTime() + leaseTtlMs),
        },
      }
    );

    return result.matchedCount === 1;
  }

  static async releaseLease(ownerToken, cursor) {
    const update = {
      $set: {
        expiresAt: new Date(0),
        finishedAt: new Date(),
        cursor: cursor || null,
      },
      $unset: {
        ownerToken: "",
      },
    };

    await this.leaseCollection().updateOne(
      {
        _id: LEASE_KEY,
        ownerToken,
      },
      update
    );
  }

  // ───────────────────── PROCESS DUE PERMITS ─────────────────────

  static async runOnce({
    limit = DEFAULT_PROCESSING_LIMIT,
    leaseTtlMs = DEFAULT_LEASE_TTL_MS,
  } = {}) {
    if (this.isRunning) {
      return {
        skipped: true,
        reason: "previous_run_still_active",
      };
    }

    this.isRunning = true;

    let lease = null;
    let heartbeat = null;
    let heartbeatBusy = false;
    let leaseLost = false;
    let cursorToPersist = null;

    try {
      const processingLimit = this.positiveInteger(limit, "limit", MAX_PROCESSING_LIMIT);

      const ttl = this.positiveInteger(leaseTtlMs, "leaseTtlMs", 60 * 60 * 1000);

      if (ttl < 2 * 60 * 1000) {
        throw new Error("Facility permit activation lease TTL is too short.");
      }

      lease = await this.acquireLease(ttl);

      if (!lease) {
        return {
          skipped: true,
          reason: "another_instance_owns_lease",
        };
      }

      cursorToPersist = lease.cursor;

      // Keep ownership alive during long-running batches.
      heartbeat = setInterval(
        () => {
          if (heartbeatBusy || leaseLost) {
            return;
          }

          heartbeatBusy = true;

          void this.renewLease(lease.ownerToken, ttl)
            .then((renewed) => {
              if (!renewed) {
                leaseLost = true;
                logger.error("Facility permit activation scheduler lost its lease.");
              }
            })
            .catch((error) => {
              // Fail closed if the lease cannot be renewed.
              leaseLost = true;
              logger.error("Facility permit activation lease renewal failed:", error);
            })
            .finally(() => {
              heartbeatBusy = false;
            });
        },
        Math.floor(ttl / 3)
      );

      heartbeat.unref?.();

      const batch = await FacilityPermitVerificationService.getDuePermitActivationTargets({
        limit: processingLimit,
        cursor: lease.cursor,
      });

      const targets = batch.targets;

      const result = {
        inspected: targets.length,
        processedBranches: 0,
        activatedPermits: 0,
        deferredBranches: 0,
        failedBranches: [],
        stoppedEarly: false,
      };

      const visitedBranches = new Set();
      let processedCandidates = 0;

      for (const target of targets) {
        if (this.stopping || leaseLost) {
          result.stoppedEarly = true;
          break;
        }

        const branchKey = `${target.businessId}:${target.branchId}`;

        if (!visitedBranches.has(branchKey)) {
          visitedBranches.add(branchKey);
          result.processedBranches += 1;

          try {
            const activation = await FacilityPermitVerificationService.activateDuePermits({
              businessId: target.businessId,
              branchId: target.branchId,
            });

            const count = Array.isArray(activation?.activatedPermitIds)
              ? activation.activatedPermitIds.length
              : 0;

            result.activatedPermits += count;

            if (count === 0) {
              result.deferredBranches += 1;
            }
          } catch (error) {
            logger.error(`Facility permit activation failed for branch ${target.branchId}:`, error);

            result.failedBranches.push({
              businessId: target.businessId,
              branchId: target.branchId,
              errorCode: error.code || "FACILITY_PERMIT_ACTIVATION_FAILED",
            });
          }
        }

        // Advance past every inspected candidate, including failures.
        // Failed candidates are revisited on subsequent complete sweeps.
        cursorToPersist = {
          validFromDate: target.validFromDate,
          id: target.permitId,
        };

        processedCandidates += 1;
      }

      // A partial final page completes the current discovery sweep.
      // Reset the cursor so new or previously deferred records remain
      // discoverable on the next run.
      if (
        !result.stoppedEarly &&
        processedCandidates === targets.length &&
        targets.length < processingLimit
      ) {
        cursorToPersist = null;
      }

      if (leaseLost) {
        logger.error("Facility permit activation pass stopped after losing lease.");
      }

      logger.info("Facility permit activation pass completed.", {
        inspected: result.inspected,
        processedBranches: result.processedBranches,
        activatedPermits: result.activatedPermits,
        deferredBranches: result.deferredBranches,
        failedBranches: result.failedBranches.length,
        stoppedEarly: result.stoppedEarly,
      });

      return result;
    } catch (error) {
      logger.error("Facility permit activation scheduler run failed:", error);

      return {
        failed: true,
        errorCode: error.code || "FACILITY_PERMIT_ACTIVATION_SCHEDULER_FAILED",
        errorMessage: error.message || "Facility permit activation scheduler failed.",
      };
    } finally {
      if (heartbeat) {
        clearInterval(heartbeat);
      }

      if (lease) {
        try {
          await this.releaseLease(lease.ownerToken, cursorToPersist);
        } catch (error) {
          logger.error("Facility permit scheduler lease release failed:", error);
        }
      }

      this.isRunning = false;
    }
  }

  // ───────────────────── START ─────────────────────

  static start(options = {}) {
    if (this.intervalHandle) {
      logger.info("Facility permit activation scheduler is already running.");

      return this.intervalHandle;
    }

    const settings = this.normalizeOptions(options);

    this.stopping = false;

    const runOptions = {
      limit: settings.limit,
      leaseTtlMs: settings.leaseTtlMs,
    };

    const invoke = () => {
      void this.runOnce(runOptions).catch((error) => {
        logger.error("Unexpected facility permit scheduler error:", error);
      });
    };

    this.intervalHandle = setInterval(invoke, settings.intervalMinutes * 60 * 1000);

    if (settings.runImmediately) {
      invoke();
    }

    logger.info("Facility permit activation scheduler started.", {
      intervalMinutes: settings.intervalMinutes,
      limit: settings.limit,
      leaseTtlMs: settings.leaseTtlMs,
      runImmediately: settings.runImmediately,
    });

    return this.intervalHandle;
  }

  // ───────────────────── STOP ─────────────────────

  static stop() {
    this.stopping = true;

    if (!this.intervalHandle) {
      return;
    }

    clearInterval(this.intervalHandle);
    this.intervalHandle = null;

    // An active pass finishes its current operation and releases
    // the lease in runOnce(). No new target is started afterward.
    logger.info("Facility permit activation scheduler stopped.");
  }
}

module.exports = FacilityPermitActivationScheduler;
