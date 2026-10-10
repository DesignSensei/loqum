// services/jobs/jobPublicationReviewService.js

const JobQueryService = require("./jobQueryService");
const JobService = require("../jobService");
const JobPublicationService = require("../jobPublicationService");
const EntitlementService = require("../jobPublicationEntitlementService");
const PaymentService = require("../jobPublicationPaymentService");
const JobPublication = require("../../models/JobPublication");
const { FIXED_JOB_PUBLICATION_PERIOD_DAYS } = require("../../constants/jobPosting");

class JobPublicationReviewService {
  /**
   * Prepares the employer's publication review without saving a publication,
   * consuming an entitlement, or starting a payment.
   *
   * Confirmation rechecks the selected entitlement in the existing publication
   * transaction. The preview itself does not reserve publishing capacity.
   */
  static async getPageData({ userId, employerProfile, employerContext, jobId }) {
    const currentTime = new Date();

    const detail = await JobQueryService.getEmployerJobDetailData({
      userId,
      employerProfile,
      employerContext,
      jobId,
      currentTime,
    });

    if (!detail.canManageJobs) {
      throw JobService.createError({
        message: "Job management access is required.",
        code: "JOB_MANAGEMENT_NOT_ALLOWED",
        statusCode: 403,
      });
    }

    const context = {
      employerProfileId: employerProfile._id,
      employerContext,
    };

    const job = await JobService.getEmployerJob({ ...context, jobId });
    const previousDetail = detail.job;

    detail.job = {
      ...job.toObject(),
      branch:
        String(previousDetail.branch?._id || "") === String(job.branch || "")
          ? previousDetail.branch
          : null,
      currentPublication:
        String(previousDetail.currentPublication?._id || "") ===
        String(job.currentPublication || "")
          ? previousDetail.currentPublication
          : null,
    };

    const profile = await JobPublicationService.getEmployerProfileForPublication(job.business);
    const issues = [];
    let preview = null;
    let latest = null;

    try {
      JobPublicationService.assertEmployerEligibleToPublish(profile);
      latest = await JobPublicationService.getLatestPublication(job._id);
      await JobPublicationService.assertPublicationChain(job, latest);

      const expiredFixed =
        latest &&
        ["live", "paused"].includes(latest.status) &&
        ["free", "paid_single_post"].includes(latest.entitlementSnapshot?.source) &&
        latest.expiresAt &&
        new Date(latest.expiresAt) <= currentTime;

      JobPublicationService.assertJobPublishable({
        ...job.toObject(),
        publicationStatus: expiredFixed ? "expired" : job.publicationStatus,
      });

      const branch = await JobService.getActiveBranch({ ...context, branchId: job.branch });
      detail.job.branch = branch.toObject ? branch.toObject() : branch;

      // Validate the same snapshots used by publication without saving a document.
      const candidate = new JobPublication({
        listingSnapshot: JobPublicationService.buildListingSnapshot(job, currentTime),
        employerSnapshot: JobPublicationService.buildEmployerSnapshot(profile, branch),
      });

      await candidate.listingSnapshot.validate();
      await candidate.employerSnapshot.validate();

      preview = await EntitlementService.getPublicationPreview({
        employerProfileId: profile._id,
        currentTime,
      });

      const authorityEnd =
        preview.sourceType === "subscription_slot"
          ? new Date(preview.subscription.currentPeriodEnd)
          : new Date(currentTime.getTime() + FIXED_JOB_PUBLICATION_PERIOD_DAYS * 86400000);

      if (preview.sourceType || preview.canPurchase) {
        JobPublicationService.validatePublicationDeadline({
          applicationDeadline: job.applicationDeadline,
          minimumTime: currentTime,
          authorityEnd,
          entitlementSource: preview.sourceType,
        });
      }
    } catch (error) {
      if (error.name === "ValidationError") {
        issues.push(...Object.values(error.errors).map((item) => item.message));
      } else if ((error.statusCode >= 400 && error.statusCode < 500) || error.statusCode === 503) {
        issues.push(error.message);
      } else {
        throw error;
      }
    }

    const canPurchase =
      employerContext?.isPrimaryEmployer === true || employerContext?.isBusinessAdmin === true;

    const pendingPayments = canPurchase
      ? await PaymentService.getPendingPurchasesForEmployer(context)
      : [];

    const plans =
      canPurchase &&
      preview?.canPurchase &&
      !preview.sourceType &&
      !issues.length &&
      !pendingPayments.length
        ? await PaymentService.listActivePlans({ employerProfileId: profile._id })
        : [];

    return {
      detail,
      preview,
      issues,
      pendingPayments,
      plans,
      canPurchase,
      canPayFromWallet: canPurchase && employerContext?.canManageWallet === true,
      periodDays: FIXED_JOB_PUBLICATION_PERIOD_DAYS,
      review: {
        jobUpdatedAt: new Date(job.updatedAt).toISOString(),
        sourceType: preview?.sourceType,
        sourceReference: preview?.sourceReference,
      },
    };
  }
}

module.exports = JobPublicationReviewService;
