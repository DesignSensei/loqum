// middleware/googleOAuthMiddleware.js

const passport = require("passport");

const { saveSession } = require("../utils/sessionHelper");

const { isValidGoogleOAuthState, clearGoogleOAuthContext } = require("../utils/googleOAuthState");

// ───────────────────── OAUTH STATE VERIFICATION ─────────────────────

/*
 * Verify that Google's callback belongs to the
 * OAuth request initiated by this browser session.
 *
 * State must be:
 * - Present in the session;
 * - Cryptographically valid;
 * - Equal to the value returned by Google;
 * - Within the permitted lifetime;
 * - Consumed before Passport processes the callback.
 *
 * The application's Google Passport strategy does
 * not independently manage OAuth state.
 */

async function requireValidGoogleOAuthState(req, res, next) {
  try {
    const context = req.session?.oauthContext;

    const receivedState = typeof req.query?.state === "string" ? req.query.state : null;

    const validState = isValidGoogleOAuthState({
      expectedState: context?.state,
      receivedState,
      issuedAt: context?.issuedAt,
    });

    if (!validState) {
      clearGoogleOAuthContext(req);

      await saveSession(req);

      return res.redirect("/login?error=google_auth_invalid");
    }

    /*
     * Consume the state before processing Google's
     * authorization response.
     *
     * Preserve the remaining OAuth context because
     * config/passport.js needs the role, intent
     * and invitation token.
     */

    delete context.state;
    delete context.issuedAt;

    await saveSession(req);

    return next();
  } catch (error) {
    return next(error);
  }
}

// ───────────────────── GOOGLE CALLBACK AUTHENTICATION ─────────────────────

/*
 * Authenticate Google's response without creating
 * a persistent application login session.
 *
 * The existing route handler decides whether
 * two-factor authentication must be completed.
 */

function authenticateGoogleCallback(req, res, next) {
  return passport.authenticate(
    "google",
    {
      session: false,
    },
    (error, user) => {
      if (error || !user) {
        clearGoogleOAuthContext(req);

        return req.session.save((saveError) => {
          if (saveError) {
            return next(saveError);
          }

          if (error) {
            return next(error);
          }

          return res.redirect("/login");
        });
      }

      /*
       * A custom Passport callback does not
       * automatically assign req.user.
       *
       * This assignment identifies the Google user
       * for the current request only.
       *
       * It does not establish a Passport session.
       */

      req.user = user;

      return next();
    }
  )(req, res, next);
}

module.exports = {
  requireValidGoogleOAuthState,
  authenticateGoogleCallback,
};
