// utils/googleOAuthState.js

const crypto = require("crypto");

const GOOGLE_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const GOOGLE_OAUTH_STATE_PATTERN = /^[a-f0-9]{64}$/;

// ───────────────────── STATE GENERATION ─────────────────────

function generateGoogleOAuthState() {
  return crypto.randomBytes(32).toString("hex");
}

// ───────────────────── STATE VALIDATION ─────────────────────

function isValidGoogleOAuthState({
  expectedState,
  receivedState,
  issuedAt,
  now = Date.now(),
} = {}) {
  if (
    typeof expectedState !== "string" ||
    typeof receivedState !== "string" ||
    !GOOGLE_OAUTH_STATE_PATTERN.test(expectedState) ||
    !GOOGLE_OAUTH_STATE_PATTERN.test(receivedState)
  ) {
    return false;
  }

  if (
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(now) ||
    issuedAt > now ||
    now - issuedAt > GOOGLE_OAUTH_STATE_TTL_MS
  ) {
    return false;
  }

  const expected = Buffer.from(expectedState, "hex");
  const received = Buffer.from(receivedState, "hex");

  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

// ───────────────────── CONTEXT CLEANUP ─────────────────────

function clearGoogleOAuthContext(req) {
  if (req.session) {
    delete req.session.oauthContext;
  }
}

module.exports = {
  generateGoogleOAuthState,
  isValidGoogleOAuthState,
  clearGoogleOAuthContext,
};
