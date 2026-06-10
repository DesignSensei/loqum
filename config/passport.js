// config/passport.js

const LocalStrategy = require("passport-local").Strategy;
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const bcrypt = require("bcryptjs");
const User = require("../models/User");

module.exports = function (passport) {
  /* --------------------------- Local Strategy --------------------------- */
  passport.use(
    new LocalStrategy({ usernameField: "email" }, async (email, password, done) => {
      try {
        const normalizedEmail = email?.toLowerCase().trim();

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

          const email = profile.emails?.[0]?.value?.toLowerCase().trim() || null;

          const displayName = profile.displayName || "";

          const photo = profile.photos?.[0]?.value || "";

          const firstName = profile.name?.givenName || displayName.split(" ")[0] || "";

          const lastName =
            profile.name?.familyName || displayName.split(" ").slice(1).join(" ") || "";

          if (!email) {
            return done(null, false, {
              message: "Google account does not have an email address.",
            });
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

            delete req.session.oauthContext;

            return done(null, user);
          }

          user = await User.findOne({ email });

          if (user) {
            delete req.session.oauthContext;

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

          const oauthContext = req.session.oauthContext;

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
            isVerified: true,
            isOnboarded: false,
            twoFactorEnabled: true,
          });

          delete req.session.oauthContext;

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
