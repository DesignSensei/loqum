// services/emailService.js

const { Resend } = require("resend");
const logger = require("../utils/logger");

const resend = new Resend(process.env.RESEND_API_KEY);

const BRAND_PURPLE = "#6A23FF";
const BRAND_PURPLE_LIGHT = "#F4EEFF";
const LOGO_WHITE_URL = "https://findloqum.com/assets/images/logo-white.png";

const TEXT_DARK = "#1F2933";
const TEXT_MUTED = "#6B7280";
const BORDER_LIGHT = "#E5E7EB";

const WARNING_BG = "#FFF8F0";
const WARNING_BORDER = "#F59E0B";
const WARNING_TEXT = "#92400E";

class EmailService {
  static escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  static getHeaderHtml() {
    return `
      <div style="background: ${BRAND_PURPLE}; padding: 40px 40px 30px; text-align: center;">
        <img 
          src="${LOGO_WHITE_URL}" 
          alt="Loqum logo" 
          style="height: 40px; width: auto;"
          onerror="this.style.display='none'; this.nextElementSibling.style.display='block';"
        />
        <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 700; letter-spacing: 1px; display: none;">Loqum</h1>
      </div>
    `;
  }

  static getFooterHtml() {
    return `
      <div style="background: #F9FAFB; border-top: 1px solid ${BORDER_LIGHT}; padding: 24px 40px; text-align: center;">
        <p style="color: #9CA3AF; font-size: 12px; margin: 0 0 4px;">© 2026 Loqum. All rights reserved.</p>
        <p style="color: #9CA3AF; font-size: 12px; margin: 0;">This is an automated message, please do not reply.</p>
      </div>
    `;
  }

  static getEmailShell(bodyHtml) {
    return `
      <div style="font-family: 'Fustat', Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.08);">
        ${EmailService.getHeaderHtml()}
        ${bodyHtml}
        ${EmailService.getFooterHtml()}
      </div>
    `;
  }

  static async sendEmail({ to, subject, html, logLabel }) {
    try {
      const { data, error } = await resend.emails.send({
        from: `Loqum <${process.env.EMAIL_FROM}>`,
        to,
        subject,
        html,
      });

      if (error) {
        logger.error(`Resend ${logLabel} error for ${to}: ${JSON.stringify(error)}`);
        throw new Error(error.message || `Failed to send ${logLabel} email`);
      }

      logger.info(`${logLabel} email sent to ${to}. Resend email ID: ${data?.id}`);

      return data;
    } catch (error) {
      logger.error(`Failed to send ${logLabel} email to ${to}: ${error.message}`);
      throw new Error(`Failed to send ${logLabel} email`);
    }
  }

  static async sendOTP(email, otp) {
    const safeOtp = EmailService.escapeHtml(otp);

    const html = EmailService.getEmailShell(`
      <div style="padding: 40px;">
        <h2 style="color: ${TEXT_DARK}; font-size: 22px; font-weight: 700; margin: 0 0 12px;">
          Your One-Time Password
        </h2>

        <p style="color: ${TEXT_DARK}; font-size: 15px; line-height: 1.6; margin: 0 0 32px;">
          Use the code below to complete your verification. This code expires in <strong>10 minutes</strong> and can only be used once.
        </p>

        <div style="background: ${BRAND_PURPLE_LIGHT}; border: 2px dashed ${BRAND_PURPLE}; border-radius: 12px; padding: 28px; text-align: center; margin-bottom: 32px;">
          <p style="color: ${TEXT_DARK}; font-size: 13px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; margin: 0 0 12px;">
            Your verification code
          </p>

          <div style="font-size: 42px; font-weight: 800; letter-spacing: 16px; color: ${BRAND_PURPLE}; font-family: 'Courier New', monospace;">
            ${safeOtp}
          </div>
        </div>

        <div style="background: ${WARNING_BG}; border-left: 4px solid ${WARNING_BORDER}; border-radius: 4px; padding: 14px 16px; margin-bottom: 32px;">
          <p style="color: ${WARNING_TEXT}; font-size: 13px; margin: 0; line-height: 1.5;">
            <strong>Security tip:</strong> Never share this code with anyone. Loqum will never ask for your OTP via phone or email.
          </p>
        </div>

        <p style="color: ${TEXT_MUTED}; font-size: 13px; line-height: 1.6; margin: 0;">
          If you did not request this code, you can safely ignore this email. Someone may have entered your email address by mistake.
        </p>
      </div>
    `);

    return EmailService.sendEmail({
      to: email,
      subject: "Your One-Time Password",
      html,
      logLabel: "OTP",
    });
  }

  static async sendResetLink(email, resetUrl) {
    const safeResetUrl = EmailService.escapeHtml(resetUrl);

    const html = EmailService.getEmailShell(`
      <div style="padding: 40px;">
        <h2 style="color: ${TEXT_DARK}; font-size: 22px; font-weight: 700; margin: 0 0 12px;">
          Reset Your Password
        </h2>

        <p style="color: ${TEXT_DARK}; font-size: 15px; line-height: 1.6; margin: 0 0 32px;">
          We received a request to reset your password. Click the button below to choose a new one. This link expires in <strong>30 minutes</strong>.
        </p>

        <div style="text-align: center; margin-bottom: 32px;">
          <a href="${safeResetUrl}" style="display: inline-block; background: ${BRAND_PURPLE}; color: #ffffff; font-size: 15px; font-weight: 700; text-decoration: none; padding: 14px 32px; border-radius: 8px; letter-spacing: 0.5px;">
            Reset Password
          </a>
        </div>

        <div style="background: ${WARNING_BG}; border-left: 4px solid ${WARNING_BORDER}; border-radius: 4px; padding: 14px 16px; margin-bottom: 32px;">
          <p style="color: ${WARNING_TEXT}; font-size: 13px; margin: 0; line-height: 1.5;">
            <strong>Security tip:</strong> If you did not request a password reset, please ignore this email or contact support if you have concerns.
          </p>
        </div>

        <p style="color: ${TEXT_MUTED}; font-size: 13px; line-height: 1.6; margin: 0;">
          Or copy and paste this link into your browser:<br/>
          <a href="${safeResetUrl}" style="color: ${BRAND_PURPLE}; word-break: break-all;">${safeResetUrl}</a>
        </p>
      </div>
    `);

    return EmailService.sendEmail({
      to: email,
      subject: "Reset Your Password",
      html,
      logLabel: "password reset",
    });
  }

  static async sendInvite(email, inviteUrl, inviteLabel) {
    const safeInviteUrl = EmailService.escapeHtml(inviteUrl);
    const safeInviteLabel = EmailService.escapeHtml(inviteLabel || "this business");

    const html = EmailService.getEmailShell(`
      <div style="padding: 40px;">
        <h2 style="color: ${TEXT_DARK}; font-size: 22px; font-weight: 700; margin: 0 0 12px;">
          You've Been Invited
        </h2>

        <p style="color: ${TEXT_DARK}; font-size: 15px; line-height: 1.6; margin: 0 0 32px;">
          You have been invited to join <strong>${safeInviteLabel}</strong> on Loqum as a team member. Click the button below to set up your account and get started. This invite expires in <strong>48 hours</strong>.
        </p>

        <div style="text-align: center; margin-bottom: 32px;">
          <a href="${safeInviteUrl}" style="display: inline-block; background: ${BRAND_PURPLE}; color: #ffffff; font-size: 15px; font-weight: 700; text-decoration: none; padding: 14px 32px; border-radius: 8px; letter-spacing: 0.5px;">
            Accept Invite
          </a>
        </div>

        <div style="background: ${WARNING_BG}; border-left: 4px solid ${WARNING_BORDER}; border-radius: 4px; padding: 14px 16px; margin-bottom: 32px;">
          <p style="color: ${WARNING_TEXT}; font-size: 13px; margin: 0; line-height: 1.5;">
            <strong>Note:</strong> This invite link is personal and should not be shared with anyone else. It will expire after 48 hours.
          </p>
        </div>

        <p style="color: ${TEXT_MUTED}; font-size: 13px; line-height: 1.6; margin: 0;">
          Or copy and paste this link into your browser:<br/>
          <a href="${safeInviteUrl}" style="color: ${BRAND_PURPLE}; word-break: break-all;">${safeInviteUrl}</a>
        </p>
      </div>
    `);

    return EmailService.sendEmail({
      to: email,
      subject: "You've Been Invited to Join Loqum",
      html,
      logLabel: `invite for ${safeInviteLabel}`,
    });
  }
}

module.exports = EmailService;
