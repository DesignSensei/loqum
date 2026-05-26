//config/passport.js

const LocalStrategy = require("passport-local").Strategy;
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const bcrypt = require("bcryptjs");
const User = require("../models/User");

module.exports = function (passport) {
  /* --------------------------- Local Strategy (Email + Password) --------------------------- */
  passport.use(
    new LocalStrategy({ usernameField: "email" }, async (email, password, done) => {
      try {
        // Find user by email
        const user = await User.findOne({ email }).select("+password");

        if (!user) {
          return done(null, false, { message: "Invalid credentials" });
        }

        // Skip password for Google logins
        if (user.authProvider === "google" && !user.password) {
          return done(null, false, {
            message: "This account was created with Google. Please sign in with Google.",
          });
        }

        // Compare inputted password with hashed password in DB
        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
          return done(null, false, { message: "Invalid credentials" });
        }

        // Success: return user (Passport will attach this to req.user)
        return done(null, user);
      } catch (err) {
        return done(err);
      }
    })
  );

  /* --------------------------- GOOGLE Strategy (OAuth 2.0) --------------------------- */
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

          const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;

          const displayName = profile.displayName || "";

          const photo = profile.photos && profile.photos[0] ? profile.photos[0].value : "";

          const firstName = profile.name?.givenName || displayName.split(" ")[0] || "";
          const lastName =
            profile.name?.familyName || displayName.split(" ").slice(1).join(" ") || "";

          if (!email) {
            return done(null, false, {
              message: "Google account does not have an email address.",
            });
          }

          let user = await User.findOne({
            $or: [{ googleId }, { email }],
          });

          if (user) {
            if (!user.googleId) {
              user.googleId = googleId;
            }

            if (!user.photo && photo) {
              user.photo = photo;
            }

            await user.save();

            delete req.session.oauthContext;

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
          });

          delete req.session.oauthContext;

          return done(null, user);
        } catch (err) {
          return done(err);
        }
      }
    )
  );

  // Serialize: only store user ID in session
  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  // Deserialize: retrieve full user object (without password)
  passport.deserializeUser(async (id, done) => {
    try {
      const user = await User.findById(id).select("-password");
      done(null, user);
    } catch (err) {
      done(err);
    }
  });
};
