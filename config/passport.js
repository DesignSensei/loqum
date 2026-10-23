// config/passport.js

const LocalStrategy = require("passport-local").Strategy;
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const bcrypt = require("bcryptjs");

const User = require("../models/User");
const InviteService = require("../services/inviteService");

module.exports = function (passport) {
  /* --------------------------- Local Strategy --------------------------- */

  passport.use(
    new LocalStrategy({ usernameField: "email" }, async (email, password, done) => {
      try {
        const normalizedEmail = String(email || "")
          .toLowerCase()
          .trim();

        if (!normalizedEmail || !password) {
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

        if (!user.password) {
          return done(null, false, {
            message: "Password login is not available for this account.",
          });
        }

        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
          return done(null, false, { message: "Invalid credentials" });
        }

        if (["suspended", "deactivated", "banned"].includes(user.accountStatus)) {
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
          const googleId = profile.id;

          const email = String(profile.emails?.[0]?.value || "")
            .toLowerCase()
            .trim();

          const displayName = String(profile.displayName || "").trim();
          const photo = profile.photos?.[0]?.value || "";

          /*
           * Google provides account-profile names,
           * not authoritative Nigerian NIN legal names.
           *
           * Never populate a professional's firstName,
           * middleName or lastName from Google.
           *
           * Do not split displayName to invent
           * missing structured name components.
           *
           * Employer accounts may use Google's
           * structured givenName and familyName
           * as unverified account-holder information.
           *
           * These names do not establish the
           * employer's CAC-registered business name.
           */

          const googleFirstName = String(profile.name?.givenName || "").trim();
          const googleLastName = String(profile.name?.familyName || "").trim();

          if (!googleId) {
            return done(null, false, {
              message: "Google account identification failed. Please try again.",
            });
          }

          if (!email) {
            return done(null, false, {
              message: "Google account does not have an email address.",
            });
          }

          /*
           * Require evidence that Google has
           * verified the returned email address.
           *
           * Email verification establishes an
           * authenticated account email only.
           *
           * It does not prove NIN identity-holder
           * authentication, professional licensing,
           * CAC authority or marketplace approval.
           */

          const matchingGoogleEmail = Array.isArray(profile.emails)
            ? profile.emails.find((item) => {
                return (
                  String(item?.value || "")
                    .toLowerCase()
                    .trim() === email
                );
              })
            : null;

          const googleEmailVerified =
            profile._json?.email_verified === true || matchingGoogleEmail?.verified === true;

          if (!googleEmailVerified) {
            return done(null, false, {
              message: "Your Google email address could not be verified.",
            });
          }

          const oauthContext = req.session?.oauthContext || {};
          const inviteToken = String(oauthContext.inviteToken || "").trim();

          /*
           * Important:
           * If this is a Google invite signup, validate the invite before creating
           * a new user. This prevents creating an orphan Google user when the Google
           * email does not match the invite email.
           *
           * Loqum invitations are exclusively for
           * employer team members.
           *
           * Professionals cannot be invited.
           *
           * A validated employer invitation
           * establishes the new account's User
           * role as "employer", independently
           * of any role supplied in OAuth state.
           *
           * InviteService must also enforce
           * employer-only invitation eligibility.
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
            /*
             * A previously registered Google user
             * must not gain employer membership
             * through an invite if the account
             * belongs to a professional or admin.
             */

            if (inviteToken && user.role !== "employer") {
              return done(null, false, {
                message: "Team invitations can only be accepted by employer accounts.",
              });
            }

            if (["suspended", "deactivated", "banned"].includes(user.accountStatus)) {
              return done(null, false, {
                message: "This account is not currently permitted to sign in.",
              });
            }

            /*
             * Existing professional legal names
             * are never refreshed using Google.
             *
             * Google displayName and photo remain
             * non-authoritative profile information.
             */

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

            if (["suspended", "deactivated", "banned"].includes(user.accountStatus)) {
              return done(null, false, {
                message: "This account is not currently permitted to sign in.",
              });
            }

            /*
             * Do not replace an already linked
             * Google account with a different
             * Google identity solely because
             * the emails match.
             */

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
           * Ordinary signup requires an explicitly
           * selected professional or employer role.
           *
           * A validated employer team invitation
           * is the only exception: the invitation
           * itself establishes the employer role.
           *
           * Never allow public Google signup
           * to assign the admin role.
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
           * Employer account-holder first and
           * last names remain required.
           *
           * Use only Google's structured fields.
           * Do not manufacture fallback names
           * such as "Google User".
           *
           * If either component is unavailable,
           * the employer may use ordinary email
           * registration to provide their
           * account-holder information.
           */

          if (accountRole === "employer" && (!googleFirstName || !googleLastName)) {
            return done(null, false, {
              message:
                "Google did not provide your first and last names. Please register using email and password instead.",
            });
          }

          /*
           * Professional legal names remain empty
           * until the authenticated onboarding
           * workflow consumes valid production NIN
           * registry evidence acknowledged by
           * the applicant.
           *
           * NIN-derived legal names and the
           * permanent KYC evidence reference
           * are not established during OAuth.
           */

          const isProfessional = accountRole === "professional";

          user = await User.create({
            googleId,
            email,

            /*
             * Google display names are not
             * NIN-derived legal names.
             */
            displayName,
            photo,

            firstName: isProfessional ? "" : googleFirstName,
            middleName: "",
            lastName: isProfessional ? "" : googleLastName,

            legalNameSource: "unverified",
            legalNameEvidence: null,

            role: accountRole,
            authProvider: "google",

            /**
             * Google has authenticated ownership of this email.
             *
             * This does not establish NIN identity,
             * PCN licence verification, employer CAC
             * verification or marketplace approval.
             */
            isVerified: true,

            /**
             * User still needs onboarding or invite finalization.
             * Invite acceptance happens in authRoutes.js after Passport returns.
             */
            isOnboarded: false,

            /**
             * Keeping your existing behavior.
             * If you do not want Google signup users to go through Loqum OTP
             * immediately after Google auth, set this to false.
             */
            twoFactorEnabled: true,
          });

          /**
           * Do not delete req.session.oauthContext here.
           * authRoutes.js still needs inviteToken after Passport finishes.
           */
          return done(null, user);
        } catch (err) {
          if (err.code === 11000) {
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
    done(null, user.id);
  });

  passport.deserializeUser(async (id, done) => {
    try {
      const user = await User.findById(id).select("-password");

      done(null, user);
    } catch (err) {
      done(err);
    }
  });
};
