// services/adminUserViewService.js

const DIRECTORY_URL = "/admin/users";

const STATUS_LABELS = {
  active: "Active",
  approved: "Approved",
  banned: "Banned",
  complete: "Completed",
  deactivated: "Deactivated",
  expired: "Expired",
  hidden: "Hidden",
  incomplete: "Incomplete",
  manual: "Manual",
  api: "API",
  provider: "Provider",
  needs_review: "Needs Review",
  not_available: "Not Available",
  not_checked: "Not Checked",
  not_onboarded: "Not Onboarded",
  not_started: "Not Started",
  paused: "Paused",
  pending: "Pending",
  rejected: "Rejected",
  restricted: "Restricted",
  suspended: "Suspended",
  verified: "Verified",
  visible: "Visible",
};

const STATUS_COLORS = {
  active: "success",
  approved: "success",
  complete: "success",
  verified: "success",
  visible: "success",

  pending: "warning",
  needs_review: "warning",
  incomplete: "warning",

  rejected: "danger",
  restricted: "danger",
  suspended: "danger",
  banned: "danger",
  deactivated: "danger",
  expired: "danger",

  not_onboarded: "secondary",
  not_available: "secondary",
  not_started: "secondary",
  not_checked: "secondary",
  hidden: "secondary",
  paused: "secondary",
};

class AdminUserViewService {
  // ───────── Formatting ─────────

  static displayValue(value, fallback = "—") {
    if (value === undefined || value === null || value === "") {
      return fallback;
    }

    return String(value);
  }

  static formatLabel(value) {
    if (value === undefined || value === null || value === "") {
      return "Not Available";
    }

    const normalized = String(value).trim().toLowerCase();

    if (STATUS_LABELS[normalized]) {
      return STATUS_LABELS[normalized];
    }

    return normalized.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
  }

  static formatDate(value, includeTime = false) {
    if (!value) {
      return "—";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return "—";
    }

    const options = {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "Africa/Lagos",
    };

    if (includeTime) {
      options.hour = "2-digit";
      options.minute = "2-digit";
      options.hour12 = true;
    }

    return new Intl.DateTimeFormat("en-NG", options).format(date);
  }

  static formatNumber(value) {
    return new Intl.NumberFormat("en-NG").format(Number(value) || 0);
  }

  static formatFullName(user) {
    if (!user) {
      return "Unknown User";
    }

    const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();

    return name || user.displayName || user.email || "Unknown User";
  }

  static formatPhone(code, number) {
    return this.displayValue([code, number].filter(Boolean).join(" "));
  }

  static formatLocation(state, lga) {
    return this.displayValue([lga, state].filter(Boolean).join(", "));
  }

  // ───────── Presentation helpers ─────────

  static badge(status, label) {
    const normalized = String(status || "not_available").toLowerCase();

    const color = STATUS_COLORS[normalized] || "secondary";

    return {
      status: normalized,
      label: label || this.formatLabel(normalized),
      color,
      className: `badge badge-light-${color}`,
    };
  }

  static field(label, value, options = {}) {
    const text =
      options.formatted === true
        ? this.displayValue(value)
        : options.dateTime === true
          ? this.formatDate(value, true)
          : options.date === true
            ? this.formatDate(value)
            : this.displayValue(value);

    return {
      label,
      value: text,
      badge: options.badgeStatus ? this.badge(options.badgeStatus, options.badgeLabel) : null,
    };
  }

  static section(title, fields, options = {}) {
    return {
      key: options.key || null,
      title,
      description: options.description || "",
      fields,
      badge: options.badge || null,
      notes: options.notes || [],
      notice: options.notice || null,
      action: options.action || null,
      externalLink: options.externalLink || null,
      reviewForm: options.reviewForm || null,
    };
  }

  static note(label, value) {
    if (value === undefined || value === null || String(value).trim() === "") {
      return null;
    }

    return {
      label,
      text: String(value),
    };
  }

  static withoutEmptyNotes(notes) {
    return notes.filter(Boolean);
  }

  static getRoleMetadata(role) {
    if (role === "employer") {
      return {
        role: "employer",
        singular: "Employer",
        plural: "Employers",
        description: "Manage employer accounts and CAC business verification.",
        searchPlaceholder: "Search name, business, email, or registration number",
      };
    }

    return {
      role: "professional",
      singular: "Professional",
      plural: "Professionals",
      description:
        "Manage healthcare professionals, credential verification, and platform approval.",
      searchPlaceholder: "Search name, email, licence number, or specialty",
    };
  }

  // ───────── Navigation ─────────

  static buildDirectoryUrl(role, filters = {}) {
    const params = new URLSearchParams();

    params.set("role", role);

    if (filters.search) {
      params.set("search", filters.search);
    }

    if (filters.status && filters.status !== "all") {
      params.set("status", filters.status);
    }

    if (filters.accountStatus && filters.accountStatus !== "all") {
      params.set("accountStatus", filters.accountStatus);
    }

    if (Number.isInteger(filters.page) && filters.page > 1) {
      params.set("page", String(filters.page));
    }

    return `${DIRECTORY_URL}?${params.toString()}`;
  }

  static buildUserDetailsUrl(userId) {
    return `${DIRECTORY_URL}/${encodeURIComponent(String(userId))}`;
  }

  static buildRoleTabs(selectedRole) {
    return [
      {
        label: "Employers",
        role: "employer",
        url: this.buildDirectoryUrl("employer"),
        active: selectedRole === "employer",
      },
      {
        label: "Professionals",
        role: "professional",
        url: this.buildDirectoryUrl("professional"),
        active: selectedRole === "professional",
      },
    ];
  }

  // ───────── Directory summary ─────────

  static buildSummaryCards(role, summary, status) {
    const metadata = this.getRoleMetadata(role);

    const cards = [
      {
        key: "total",
        label: `Total ${metadata.plural}`,
        value: summary.total,
        description: "Registered user accounts",
        filter: "all",
        color: "primary",
      },
      {
        key: "attention",
        label: "Needs Attention",
        value: summary.requiresAttention,
        description: "Verification requires action",
        filter: "attention",
        color: "warning",
      },
      {
        key: "verified",
        label: "Verified",
        value: summary.verified,
        description:
          role === "employer" ? "CAC identity verified" : "Identity and licence verified",
        filter: "verified",
        color: "success",
      },
      {
        key: "not_onboarded",
        label: "Not Onboarded",
        value: summary.notOnboarded,
        description: "Profile not yet created",
        filter: "not_onboarded",
        color: "secondary",
      },
    ];

    return cards.map((card) => ({
      ...card,
      valueText: this.formatNumber(card.value),
      url: this.buildDirectoryUrl(role, {
        status: card.filter,
      }),
      active: status === card.filter,
    }));
  }

  // ───────── Directory filters ─────────

  static buildSelectOptions(options, selectedValue) {
    return options.map((option) => ({
      ...option,
      selected: option.value === selectedValue,
    }));
  }

  static buildDirectoryFilters(role, filters) {
    const metadata = this.getRoleMetadata(role);

    const verificationOptions = [
      {
        value: "all",
        label: "All Verification Statuses",
      },
      {
        value: "attention",
        label: "Needs Attention",
      },
      {
        value: "pending",
        label: "Pending",
      },
      {
        value: "needs_review",
        label: "Needs Review",
      },
      {
        value: "verified",
        label: "Verified",
      },
      {
        value: "rejected",
        label: "Rejected",
      },
    ];

    if (role === "professional") {
      verificationOptions.push({
        value: "expired",
        label: "Expired Licence",
      });
    }

    verificationOptions.push({
      value: "not_onboarded",
      label: "Not Onboarded",
    });

    const accountOptions = [
      {
        value: "all",
        label: "All Account Statuses",
      },
      {
        value: "active",
        label: "Active",
      },
      {
        value: "restricted",
        label: "Restricted",
      },
      {
        value: "suspended",
        label: "Suspended",
      },
      {
        value: "deactivated",
        label: "Deactivated",
      },
      {
        value: "banned",
        label: "Banned",
      },
    ];

    return {
      action: DIRECTORY_URL,
      method: "get",
      role,

      search: {
        name: "search",
        value: filters.search || "",
        placeholder: metadata.searchPlaceholder,
      },

      verification: {
        name: "status",
        value: filters.status,
        options: this.buildSelectOptions(verificationOptions, filters.status),
      },

      account: {
        name: "accountStatus",
        value: filters.accountStatus,
        options: this.buildSelectOptions(accountOptions, filters.accountStatus),
      },

      clearUrl: this.buildDirectoryUrl(role),

      hasActiveFilters: Boolean(
        filters.search || filters.status !== "all" || filters.accountStatus !== "all"
      ),
    };
  }

  // ───────── Directory table ─────────

  static buildVerificationComponents(role, profile) {
    if (!profile) {
      return [];
    }

    if (role === "employer") {
      return [
        {
          label: "CAC",
          badge: this.badge(profile.cacVerificationStatus),
        },
      ];
    }

    return [
      {
        label: "Identity",
        badge: this.badge(profile.identityVerificationStatus),
      },
      {
        label: "Licence",
        badge: this.badge(profile.licenceVerificationStatus),
      },
    ];
  }

  static buildDirectoryRow(role, user) {
    const profile = user.profile || null;
    const fullName = this.formatFullName(user);

    const primaryName = role === "employer" ? profile?.businessName || fullName : fullName;

    const secondaryName = role === "employer" && profile?.businessName ? fullName : "";

    const profileType = profile?.type ? this.formatLabel(profile.type) : "—";

    const profileDescription =
      role === "professional"
        ? this.displayValue(profile?.specialty)
        : this.displayValue(profile?.state);

    const profileAccountStatus = profile?.accountStatus || null;

    return {
      id: String(user._id),

      name: primaryName,
      secondaryName,

      email: this.displayValue(user.email),

      profileType,
      profileDescription,

      verification: {
        badge: this.badge(user.verificationStatus),
        components: this.buildVerificationComponents(role, profile),
        requiresAttention: Boolean(user.requiresAttention),
      },

      ...(role === "professional" ? { approval: this.badge(user.approvalStatus) } : {}),

      account: {
        badge: this.badge(user.accountStatus),

        profileStatusBadge:
          profileAccountStatus &&
          profileAccountStatus !== "active" &&
          profileAccountStatus !== user.accountStatus
            ? this.badge(profileAccountStatus)
            : null,
      },

      onboarding: this.badge(
        user.isOnboarded ? "complete" : "incomplete",
        user.isOnboarded ? "Completed" : "Incomplete"
      ),

      joinedAt: this.formatDate(user.createdAt),

      action: {
        label: "View Details",
        url: this.buildUserDetailsUrl(user._id),
      },
    };
  }

  static buildDirectoryTable(role, users) {
    return {
      columns: [
        role === "employer" ? "Employer / Business" : "Professional",
        role === "employer" ? "Facility Type" : "Profession",
        "Verification",
        ...(role === "professional" ? ["Approval"] : []),
        "Account",
        "Onboarding",
        "Joined",
        "Actions",
      ],

      rows: users.map((user) => this.buildDirectoryRow(role, user)),

      empty: users.length === 0,

      emptyTitle: "No users found",

      emptyMessage:
        "No records match the selected filters. Try adjusting your search or verification status.",
    };
  }

  // ───────── Pagination ─────────

  static buildPagination(role, filters, pagination) {
    const { page, limit, total, totalPages } = pagination;

    const firstRecord = total === 0 ? 0 : Math.min((page - 1) * limit + 1, total);

    const lastRecord = Math.min(page * limit, total);

    const previousUrl =
      page > 1
        ? this.buildDirectoryUrl(role, {
            ...filters,
            page: page - 1,
          })
        : null;

    const nextUrl =
      page < totalPages
        ? this.buildDirectoryUrl(role, {
            ...filters,
            page: page + 1,
          })
        : null;

    return {
      page,
      totalPages,

      total,

      label: `Page ${page} of ${Math.max(1, totalPages)}`,

      info:
        total === 0
          ? "No records to display"
          : `Showing ${this.formatNumber(firstRecord)}–${this.formatNumber(lastRecord)} of ${this.formatNumber(total)} records`,

      previousUrl,
      nextUrl,

      hasPreviousPage: Boolean(previousUrl),
      hasNextPage: Boolean(nextUrl),
    };
  }

  // ───────── Index view model ─────────

  static buildDirectoryView(queryResult) {
    const { role, users, summary, filters, pagination } = queryResult;

    const metadata = this.getRoleMetadata(role);

    return {
      role,

      title: metadata.plural,
      heading: metadata.plural,
      description: metadata.description,

      navigation: this.buildRoleTabs(role),

      summaryCards: this.buildSummaryCards(role, summary, filters.status),

      filters: this.buildDirectoryFilters(role, filters),

      table: this.buildDirectoryTable(role, users),

      resultCountText:
        `${this.formatNumber(pagination.total)} matching ` +
        (pagination.total === 1 ? "user" : "users"),

      pagination: this.buildPagination(role, filters, pagination),

      verificationGuidance:
        role === "employer"
          ? "CAC verifies business identity. Each branch must separately satisfy its operating permit requirements."
          : "Professional verification covers identity and licensing. Payout KYC and final approval are separate.",

      refreshUrl: this.buildDirectoryUrl(role, {
        ...filters,
        page: pagination.page,
      }),
    };
  }

  // ───────── User overview ─────────

  static buildAccountOverview(user) {
    return this.section(
      "Account Information",
      [
        this.field("Full Name", this.formatFullName(user)),
        this.field("Email Address", user.email),
        this.field("Phone Number", this.formatPhone(user.phoneCode, user.phoneNumber)),
        this.field("Email Verification", user.isVerified ? "Verified" : "Not Verified", {
          badgeStatus: user.isVerified ? "verified" : "pending",
          badgeLabel: user.isVerified ? "Verified" : "Not Verified",
        }),
        this.field("Registration Date", user.createdAt, { date: true }),
        this.field("Last Updated", user.updatedAt, { dateTime: true }),
      ],
      {
        key: "account",
      }
    );
  }

  static buildEmployerOverview(profile) {
    return this.section(
      "Business Information",
      [
        this.field("Business Name", profile.businessName),
        this.field("Facility Type", this.formatLabel(profile.type)),
        this.field("Business Email", profile.businessEmail),
        this.field(
          "Business Phone",
          this.formatPhone(profile.businessPhoneCode, profile.businessPhone)
        ),
        this.field("State", profile.state),
        this.field("LGA", profile.lga),
        this.field("Address", profile.address),
        this.field("Country", profile.countryCode),
      ],
      {
        key: "business",
      }
    );
  }

  static buildProfessionalOverview(profile) {
    return this.section(
      "Professional Information",
      [
        this.field("Profession", this.formatLabel(profile.type)),
        this.field("Specialty", profile.specialty),
        this.field("Years of Experience", `${Number(profile.yearsOfExperience) || 0} years`),
        this.field("Location", this.formatLocation(profile.state, profile.lga)),
        this.field("Address", profile.address),
        this.field("Marketplace Visibility", this.formatLabel(profile.marketplaceStatus), {
          badgeStatus: profile.marketplaceStatus || "not_available",
        }),
        this.field("Profile Account Status", this.formatLabel(profile.accountStatus), {
          badgeStatus: profile.accountStatus || "not_available",
        }),
      ],
      {
        key: "professional",
      }
    );
  }

  // ───────── Employer verification ─────────

  static buildCACSection(profile) {
    const baseUrl = `/admin/employers/${encodeURIComponent(String(profile._id))}` + "/verification";

    return this.section(
      "CAC Verification",
      [
        this.field("CAC Registration Number", profile.cacRegistrationNumber),
        this.field("Registered Name", profile.cacNameOnRecord),
        this.field("Verification Method", this.formatLabel(profile.cacVerificationMethod)),
        this.field("Verification Source", this.formatLabel(profile.cacVerificationSource)),
        this.field("Verified At", profile.cacVerifiedAt, { dateTime: true }),
        this.field("Last Checked", profile.cacLastCheckedAt, { dateTime: true }),
      ],
      {
        key: "cac",

        badge: this.badge(profile.cacVerificationStatus),

        notes: this.withoutEmptyNotes([
          this.note("Verification Note", profile.cacVerificationNote),
          this.note("Rejection Reason", profile.cacRejectionReason),
        ]),

        notice: {
          color: "info",
          text:
            "Only production CAC evidence verifies a business. " +
            "Branch operating permits are reviewed separately.",
        },

        action: {
          id: "adminUserCACRecheck",
          label: "Recheck CAC",
          method: "POST",
          url: `${baseUrl}/cac/recheck`,
          confirmationTitle: "Recheck CAC Registration?",
          confirmationText: "The platform will perform a controlled CAC verification check.",
        },
      }
    );
  }

  // ───────── Professional verification ─────────

  static buildIdentitySection(profile) {
    return this.section(
      "Identity Verification",
      [
        this.field("Verification Method", this.formatLabel(profile.identityVerificationMethod)),
        this.field("Verification Source", this.formatLabel(profile.identityVerificationSource)),
        this.field("Document Type", this.formatLabel(profile.identityDocumentType)),
        this.field("Name on Document", profile.identityNameOnDocument),
        this.field("Verified At", profile.identityVerifiedAt, { dateTime: true }),
        this.field("Last Checked", profile.identityLastCheckedAt, { dateTime: true }),
      ],
      {
        key: "identity",

        badge: this.badge(profile.identityVerificationStatus),

        notes: this.withoutEmptyNotes([
          this.note("Identity Review Note", profile.identityVerificationNote),
        ]),
      }
    );
  }

  static buildLicenceSection(profile, verification) {
    const licenceExpired = Boolean(
      profile.licenceVerificationStatus === "verified" && verification.licenceExpired
    );

    return this.section(
      "Professional Licence",
      [
        this.field("Licence Number", profile.licenceNumber),
        this.field("Issuing Body", profile.licenceIssuingBody),
        this.field("Name on Record", profile.licenceNameOnRecord),
        this.field("Expiry Date", profile.licenceExpiryDate, { date: true }),
        this.field("Verification Method", this.formatLabel(profile.licenceVerificationMethod)),
        this.field("Verification Source", this.formatLabel(profile.licenceVerificationSource)),
        this.field("Verified At", profile.licenceVerifiedAt, { dateTime: true }),
        this.field("Last Checked", profile.licenceLastCheckedAt, { dateTime: true }),
      ],
      {
        key: "licence",

        badge: this.badge(licenceExpired ? "expired" : profile.licenceVerificationStatus),

        notes: this.withoutEmptyNotes([
          this.note("Licence Review Note", profile.licenceVerificationNote),
        ]),

        notice: licenceExpired
          ? {
              color: "danger",
              text:
                "The recorded professional licence has expired. " +
                "A previous verification does not establish current validity.",
            }
          : null,
      }
    );
  }

  static buildBVNSection(profile) {
    const bvn = profile.bvnVerification || {};

    return this.section(
      "BVN / Payout KYC",
      [
        this.field("Verification Status", this.formatLabel(bvn.status || "not_started")),
        this.field("Verified At", bvn.verifiedAt, { dateTime: true }),
        this.field("Last Checked", bvn.lastCheckedAt, { dateTime: true }),
      ],
      {
        key: "bvn",

        badge: this.badge(bvn.status || "not_started"),

        notice: {
          color: "info",
          text:
            "Payout KYC is separate from professional licensing. " +
            "Sensitive BVN information is not displayed here.",
        },
      }
    );
  }

  // ───────── Approval ─────────

  static buildProfessionalApprovalSection(profile, verification) {
    const approvedAt = profile.approvedForShiftsAt;
    const approvalNote = profile.approvalNote;
    const rejectionReason = profile.rejectionReason;

    return this.section(
      "Platform Approval",
      [
        this.field("Approval Status", this.formatLabel(verification.approvalStatus)),
        this.field("Approval Date", approvedAt, { dateTime: true }),
      ],
      {
        key: "approval",

        badge: this.badge(verification.approvalStatus),

        notes: this.withoutEmptyNotes([
          this.note("Administrative Note", approvalNote),
          this.note("Rejection Reason", rejectionReason),
        ]),

        notice: {
          color: "info",
          text:
            "Final approval is a separate administrative decision. " +
            "Credential verification alone does not authorize marketplace activity.",
        },
      }
    );
  }

  // ───────── Details view model ─────────

  static buildUserDetailsView(queryResult) {
    const { user, profile, verification } = queryResult;

    const role = user.role;
    const metadata = this.getRoleMetadata(role);

    const hasProfile = Boolean(profile);

    const fullName = this.formatFullName(user);

    const heading = role === "employer" && profile?.businessName ? profile.businessName : fullName;

    const overviewSections = [this.buildAccountOverview(user)];

    const verificationSections = [];

    if (profile) {
      if (role === "employer") {
        overviewSections.push(this.buildEmployerOverview(profile));

        verificationSections.push(this.buildCACSection(profile));
      } else {
        overviewSections.push(this.buildProfessionalOverview(profile));

        verificationSections.push(
          this.buildIdentitySection(profile),
          this.buildLicenceSection(profile, verification),
          this.buildBVNSection(profile),
          this.buildProfessionalApprovalSection(profile, verification)
        );
      }
    }

    const profileAccountNote = this.note(
      "Profile Account Status Reason",
      profile?.accountStatusReason
    );

    return {
      id: String(user._id),

      role,
      roleLabel: metadata.singular,

      heading,
      subtitle: user.email,

      backUrl: this.buildDirectoryUrl(role),
      backLabel: `Back to ${metadata.plural}`,

      hasProfile,

      profileId: profile ? String(profile._id) : null,

      headerBadges: [
        this.badge("not_available", metadata.singular),
        this.badge(user.accountStatus),
      ],

      summaryCards: [
        {
          key: "onboarding",
          label: "Onboarding",
          badge: this.badge(
            user.isOnboarded ? "complete" : "incomplete",
            user.isOnboarded ? "Completed" : "Incomplete"
          ),
        },
        {
          key: "verification",
          label: "Verification",
          badge: this.badge(verification.status),
        },
        ...(role === "professional"
          ? [
              {
                key: "approval",
                label: "Platform Approval",
                badge: this.badge(verification.approvalStatus),
              },
            ]
          : []),
        {
          key: "account",
          label: "Account Status",
          badge: this.badge(user.accountStatus),
        },
      ],

      tabs: [
        {
          key: "overview",
          label: "Overview",
          active: true,
          requiresAttention: false,
        },
        {
          key: "verification",
          label: "Verification",
          active: false,
          requiresAttention: verification.requiresAttention,
        },
      ],

      overviewSections,

      verificationSections,

      overviewNotes: this.withoutEmptyNotes([profileAccountNote]),

      emptyProfileNotice: !hasProfile
        ? {
            color: "warning",
            text:
              `This ${metadata.singular.toLowerCase()} has not created ` +
              "the required profile. Verification can begin after " +
              "the necessary information has been submitted.",
          }
        : null,

      verificationGuidance:
        role === "employer"
          ? "CAC confirms business identity. Branch operating permits determine facility readiness."
          : "Identity and licence verification are separate from professional approval.",

      professionalReadOnlyNotice:
        role === "professional" && hasProfile
          ? {
              color: "info",
              text:
                "Professional verification decisions will become available " +
                "after the relevant review service and audit workflow are implemented.",
            }
          : null,

      detailsDataUrl: `${DIRECTORY_URL}/${encodeURIComponent(String(user._id))}/data`,

      employerVerificationDataUrl:
        role === "employer" && hasProfile
          ? `/admin/employers/${encodeURIComponent(String(profile._id))}/verification`
          : null,

      refreshUrl: this.buildUserDetailsUrl(user._id),
    };
  }
}

module.exports = AdminUserViewService;
