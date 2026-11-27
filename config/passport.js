// config/passport.js

const LocalStrategy = require("passport-local").Strategy;
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const bcrypt = require("bcryptjs");

const User = require("../models/User");
const InviteService = require("../services/inviteService");

// Restricted users may authenticate to receive account-status guidance,
// but isAccountAllowed denies access to protected application routes.
// Missing or unexpected statuses must never be treated as active.
const SIGN_IN_PERMITTED_STATUSES = new Set(["active", "restricted"]);

function isPermittedSignInStatus(accountStatus) {
  return SIGN_IN_PERMITTED_STATUSES.has(accountStatus);
}

module.exports = function (passport) {
  /* --------------------------- Local Strategy --------------------------- */

  passport.use(
    new LocalStrategy({ usernameField: "email" }, async (email, password, done) => {
      try {
        const normalizedEmail = String(email || "")
          .toLowerCase()
          .trim();

        if (
          !normalizedEmail ||
          normalizedEmail.endsWith("@closed.loqum.invalid") ||
          !password
        ) {
          return done(null, false, { message: "Invalid credentials" });
        }

        const user = await User.findOne({ email: normalizedEmail }).select("+password");

        if (!user) {
          return done(null, false, { message: "Invalid credentials" });
        }

        if (user.authProvider === "google") {
          return done(null, false, {
            message: "This account was created with Google. Please sign in with Google.",
          });
        }

        if (user.authProvider !== "local" || !user.password) {
          return done(null, false, {
            message: "Password login is not available for this account.",
          });
        }

        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
          return done(null, false, { message: "Invalid credentials" });
        }

        if (!isPermittedSignInStatus(user.accountStatus)) {
          return done(null, false, {
            message: "This account is not currently permitted to sign in.",
          });
        }

        return done(null, user);
      } catch (err) {
        return done(err);
      }
    })
  );

  /* --------------------------- Google Strategy --------------------------- */

  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL,
        passReqToCallback: true,
      },
      async (req, accessToken, refreshToken, profile, done) => {
        try {
          const googleId = profile?.id;
          const email = String(profile?.emails?.[0]?.value || "")
            .toLowerCase()
            .trim();
          const displayName = String(profile?.displayName || "").trim();
          const photo = profile?.photos?.[0]?.value || "";

          /*
           * Google profile names are not authoritative NIN legal names.
           * Do not populate professional firstName, middleName or lastName
           * using Google data, or split displayName into name components.
           * Employer holder names may come from Google's structured fields,
           * but they do not establish a CAC-registered business name.
           */
          const googleFirstName = String(profile?.name?.givenName || "").trim();
          const googleLastName = String(profile?.name?.familyName || "").trim();

          if (!googleId) {
            return done(null, false, {
              message: "Google account identification failed. Please try again.",
            });
          }

          if (!email || email.endsWith("@closed.loqum.invalid")) {
            return done(null, false, {
              message: "Google account does not have an email address.",
            });
          }

          /*
           * Require Google-origin verification of this same email.
           * Different Google APIs can use email_verified or verified_email.
           * Email ownership is not NIN holder authentication, licensing,
           * CAC representative authority or marketplace approval.
           */
          const providerEmail = String(profile?._json?.email || "")
            .toLowerCase()
            .trim();

          if (providerEmail && providerEmail !== email) {
            return done(null, false, {
              message: "Your Google email address could not be verified.",
            });
          }

          const matchingGoogleEmail = Array.isArray(profile.emails)
            ? profile.emails.find(
                (item) =>
                  String(item?.value || "")
                    .toLowerCase()
                    .trim() === email
              )
            : null;

          const googleEmailVerified =
            profile?._json?.email_verified === true ||
            profile?._json?.verified_email === true ||
            matchingGoogleEmail?.verified === true;

          if (!googleEmailVerified) {
            return done(null, false, {
              message: "Your Google email address could not be verified.",
            });
          }

          const oauthContext = req.session?.oauthContext || {};
          const inviteToken = String(oauthContext.inviteToken || "").trim();

          /*
           * Invitations are exclusively for employer team members.
           * Validate the invite's email before creating a Google user.
           * Never derive an admin or professional role from an invitation.
           */
          if (inviteToken) {
            const invite = await InviteService.validateInviteToken(inviteToken);
            const inviteEmail = InviteService.normalizeEmail(invite.email);

            if (inviteEmail !== email) {
              return done(null, false, {
                message: "This invite was sent to a different email address.",
              });
            }
          }

          let user = await User.findOne({ googleId });

          if (user) {
            // A linked Google identity must actually belong to a Google user.
            if (user.authProvider !== "google") {
              return done(null, false, {
                message: "Google login is not available for this account.",
              });
            }

            if (inviteToken && user.role !== "employer") {
              return done(null, false, {
                message: "Team invitations can only be accepted by employer accounts.",
              });
            }

            if (!isPermittedSignInStatus(user.accountStatus)) {
              return done(null, false, {
                message: "This account is not currently permitted to sign in.",
              });
            }

            // Do not overwrite existing NIN-derived legal names.
            if (!user.photo && photo) {
              user.photo = photo;
            }

            if (!user.displayName && displayName) {
              user.displayName = displayName;
            }

            // Google verifies its own email, which may differ from the saved
            // Loqum email after an account email change. Keep that address
            // and its verification state unless Google verified the same one.
            const accountEmail = String(user.email || "")
              .toLowerCase()
              .trim();

            if (!user.isVerified && accountEmail === email) {
              user.isVerified = true;
            }

            await user.save();
            return done(null, user);
          }

          user = await User.findOne({ email });

          if (user) {
            if (user.authProvider !== "google") {
              return done(null, false, {
                message:
                  "An account with this email already exists. Please log in with email and password.",
              });
            }

            if (inviteToken && user.role !== "employer") {
              return done(null, false, {
                message: "Team invitations can only be accepted by employer accounts.",
              });
            }

            if (!isPermittedSignInStatus(user.accountStatus)) {
              return done(null, false, {
                message: "This account is not currently permitted to sign in.",
              });
            }

            // A Google email match must not replace a different linked identity.
            if (user.googleId && user.googleId !== googleId) {
              return done(null, false, {
                message: "This account is already linked to a different Google account.",
              });
            }

            user.googleId = googleId;

            if (!user.photo && photo) {
              user.photo = photo;
            }

            if (!user.displayName && displayName) {
              user.displayName = displayName;
            }

            if (!user.isVerified) {
              user.isVerified = true;
            }

            await user.save();
            return done(null, user);
          }

          /* --------------------------- New Google User --------------------------- */

          /*
           * Ordinary Google signup requires the selected professional or
           * employer role in oauthContext. A validated employer invitation
           * establishes employer role independently of the signup role.
           * Public Google signup must never assign admin privileges.
           */
          let accountRole;

          if (inviteToken) {
            accountRole = "employer";
          } else {
            const requestedRole = String(oauthContext.role || "")
              .trim()
              .toLowerCase();

            if (
              oauthContext.intent !== "signup" ||
              !["professional", "employer"].includes(requestedRole)
            ) {
              return done(null, false, {
                message: "Please select an account type before signing up with Google.",
              });
            }

            accountRole = requestedRole;
          }

          /*
           * Employer account-holder names must use Google's structured
           * given/family fields. Do not manufacture missing components.
           * Professional names remain empty until production NIN evidence
           * is acknowledged and consumed during onboarding.
           */
          if (accountRole === "employer" && (!googleFirstName || !googleLastName)) {
            return done(null, false, {
              message:
                "Google did not provide your first and last names. Please register using email and password instead.",
            });
          }

          const isProfessional = accountRole === "professional";

          user = await User.create({
            googleId,
            email,
            displayName,
            photo,

            firstName: isProfessional ? "" : googleFirstName,
            middleName: "",
            lastName: isProfessional ? "" : googleLastName,

            legalNameSource: "unverified",
            legalNameEvidence: null,

            role: accountRole,
            authProvider: "google",
            isVerified: true,
            isOnboarded: false,
            twoFactorEnabled: true,
          });

          // authRoutes.js still needs oauthContext for invite finalization.
          return done(null, user);
        } catch (err) {
          if (err?.code === 11000) {
            return done(null, false, {
              message: "An account with this email already exists. Please log in instead.",
            });
          }

          return done(err);
        }
      }
    )
  );

  /* --------------------------- Session Handling --------------------------- */

  passport.serializeUser((user, done) => {
    if (!user || !isPermittedSignInStatus(user.accountStatus)) {
      return done(new Error("This account is not permitted to sign in."));
    }

    return done(null, user.id);
  });

  passport.deserializeUser(async (id, done) => {
    try {
      // Reload each request so accountStatus, role and isVerified stay current.
      // Password remains excluded from the request user document.
      const user = await User.findById(id).select("-password");

      if (!user || user.accountStatus === "closed") {
        return done(null, false);
      }

      return done(null, user);
    } catch (err) {
      return done(err);
    }
  });
};
