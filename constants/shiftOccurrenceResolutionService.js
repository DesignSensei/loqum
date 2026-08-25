const COMPONENT_STATE_FIELDS = Object.freeze({
  base: Object.freeze([
    "baseBillableHours",

    "baseProfessionalPay",
    "basePlatformFee",
    "baseEmployerCharge",

    "cancellationCompensation",
    "activeWorkCancellation",

    "baseSettlement",

    /*
     * Employer refunds are scheduled/base-allocation money.
     *
     * If only overtime is challenged, live refund progress must survive
     * snapshot restoration.
     */
    "refundableAmount",
    "refundedAmount",

    "refundStatus",
    "refundReason",
    "refundEligibleAt",
    "refundLastEvaluatedAt",
    "refundHeldAt",
    "refundHoldReason",
  ]),

  overtime: Object.freeze([
    "overtimeProfessionalPay",
    "overtimePlatformFee",
    "overtimeEmployerCharge",

    "topUpRequired",
    "topUpTransaction",

    "overtime",

    "overtimeSettlement",
  ]),
});
