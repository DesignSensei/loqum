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

          const displayName = profile.displayName || "";
          const photo = profile.photos?.[0]?.value || "";

          const firstName = profile.name?.givenName || displayName.split(" ")[0] || "Google";

          const lastName =
            profile.name?.familyName || displayName.split(" ").slice(1).join(" ") || "User";

          if (!email) {
            return done(null, false, {
              message: "Google account does not have an email address.",
            });
          }

          const oauthContext = req.session.oauthContext || {};
          const inviteToken = String(oauthContext.inviteToken || "").trim();

          /**
           * Important:
           * If this is a Google invite signup, validate the invite before creating
           * a new user. This prevents creating an orphan Google user when the Google
           * email does not match the invite email.
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

          if (!oauthContext || oauthContext.intent !== "signup" || !oauthContext.role) {
            return done(null, false, {
              message: "Please select an account type before signing up with Google.",
            });
          }

          user = await User.create({
            googleId,
            email,
            displayName,
            photo,
            firstName,
            lastName,
            role: oauthContext.role,
            authProvider: "google",

            /**
             * Google has authenticated ownership of this email.
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
