// services/emailService.js

const { Resend } = require("resend");
const logger = require("../utils/logger");

const resend = new Resend(process.env.RESEND_API_KEY);

class EmailService {
  static async sendOTP(email, otp) {
    try {
      await resend.emails.send({
        from: `Loqum <${process.env.EMAIL_FROM}>`,
        to: email,
        subject: "Your One-Time Password",
        html: `
          <div style="font-family: "Quicksand", sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.08);">
          
          <!-- Header -->
          <div style="background: #08A562; padding: 40px 40px 30px; text-align: center;">
            <img 
              src="https://app.loqum.com/assets/images/logo_white.png" 
              alt="Loqum" 
              style="height: 40px; width: auto;"
              onerror="this.style.display='none'; this.nextElementSibling.style.display='block';"
            />
            <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 700; letter-spacing: 1px; display: none;">Loqum</h1>
          </div>

          <!-- Body -->
          <div style="padding: 40px;">
            <h2 style="color: #1F2933; font-size: 22px; font-weight: 700; margin: 0 0 12px;">Your One-Time Password</h2>
            <p style="color: #1F2933; font-size: 15px; line-height: 1.6; margin: 0 0 32px;">
              Use the code below to complete your verification. This code expires in <strong>10 minutes</strong> and can only be used once.
            </p>

            <!-- OTP Box -->
            <div style="background: #F5F8F7; border: 2px dashed #08A562; border-radius: 12px; padding: 28px; text-align: center; margin-bottom: 32px;">
              <p style="color: #1F2933; font-size: 13px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; margin: 0 0 12px;">Your verification code</p>
              <div style="font-size: 42px; font-weight: 800; letter-spacing: 16px; color: #08A562; font-family: 'Courier New', monospace;">
                ${otp}
              </div>
            </div>

            <!-- Warning -->
            <div style="background: #FFF8F0; border-left: 4px solid #F59E0B; border-radius: 4px; padding: 14px 16px; margin-bottom: 32px;">
              <p style="color: #92400E; font-size: 13px; margin: 0; line-height: 1.5;">
                <strong>Security tip:</strong> Never share this code with anyone. Loqum will never ask for your OTP via phone or email.
              </p>
            </div>

            <p style="color: #6B7280; font-size: 13px; line-height: 1.6; margin: 0;">
              If you did not request this code, you can safely ignore this email. Someone may have entered your email address by mistake.
            </p>
          </div>

          <!-- Footer -->
          <div style="background: #F9FAFB; border-top: 1px solid #E5E7EB; padding: 24px 40px; text-align: center;">
            <p style="color: #9CA3AF; font-size: 12px; margin: 0 0 4px;">© 2026 Loqum. All rights reserved.</p>
            <p style="color: #9CA3AF; font-size: 12px; margin: 0;">This is an automated message, please do not reply.</p>
          </div>

        </div>
        `,
      });

      logger.info(`OTP sent to ${email}`);
    } catch (error) {
      logger.error(`Failed to send OTP to ${email}: ${error.message}`);
      throw new Error("Failed to send OTP email");
    }
  }

  static async sendResetLink(email, resetUrl) {
    try {
      await resend.emails.send({
        from: `Loqum <${process.env.EMAIL_FROM}>`,
        to: email,
        subject: "Reset Your Password",
        html: `
        <div style="font-family: 'Fustat', sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.08);">
        
        <!-- Header -->
        <div style="background: #08A562; padding: 40px 40px 30px; text-align: center;">
          <img 
            src="https://app.loqum.com/assets/images/logo_white.png" 
            alt="Loqum" 
            style="height: 40px; width: auto;"
            onerror="this.style.display='none'; this.nextElementSibling.style.display='block';"
          />
          <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 700; letter-spacing: 1px; display: none;">Loqum</h1>
        </div>

        <!-- Body -->
        <div style="padding: 40px;">
          <h2 style="color: #1F2933; font-size: 22px; font-weight: 700; margin: 0 0 12px;">Reset Your Password</h2>
          <p style="color: #1F2933; font-size: 15px; line-height: 1.6; margin: 0 0 32px;">
            We received a request to reset your password. Click the button below to choose a new one. This link expires in <strong>30 minutes</strong>.
          </p>

          <!-- Button -->
          <div style="text-align: center; margin-bottom: 32px;">
            <a href="${resetUrl}" style="display: inline-block; background: #08A562; color: #ffffff; font-size: 15px; font-weight: 700; text-decoration: none; padding: 14px 32px; border-radius: 8px; letter-spacing: 0.5px;">
              Reset Password
            </a>
          </div>

          <!-- Warning -->
          <div style="background: #FFF8F0; border-left: 4px solid #F59E0B; border-radius: 4px; padding: 14px 16px; margin-bottom: 32px;">
            <p style="color: #92400E; font-size: 13px; margin: 0; line-height: 1.5;">
              <strong>Security tip:</strong> If you did not request a password reset, please ignore this email or contact support if you have concerns.
            </p>
          </div>

          <p style="color: #6B7280; font-size: 13px; line-height: 1.6; margin: 0;">
            Or copy and paste this link into your browser:<br/>
            <a href="${resetUrl}" style="color: #08A562; word-break: break-all;">${resetUrl}</a>
          </p>
        </div>

        <!-- Footer -->
        <div style="background: #F9FAFB; border-top: 1px solid #E5E7EB; padding: 24px 40px; text-align: center;">
          <p style="color: #9CA3AF; font-size: 12px; margin: 0 0 4px;">© 2026 Loqum. All rights reserved.</p>
          <p style="color: #9CA3AF; font-size: 12px; margin: 0;">This is an automated message, please do not reply.</p>
        </div>

      </div>
      `,
      });

      logger.info(`Password reset link sent to ${email}`);
    } catch (error) {
      logger.error(`Failed to send reset link to ${email}: ${error.message}`);
      throw new Error("Failed to send password reset email");
    }
  }
}

module.exports = EmailService;
