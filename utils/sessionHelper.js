// utils/sessionHelper.js

const User = require("../models/User");

const SIGN_IN_PERMITTED_STATUSES = new Set([
  "active",
  "restricted",
]);

exports.saveSession = (req) => {
  return new Promise((resolve, reject) => {
    req.session.save((err) => {
      if (err) return reject(err);

      return resolve();
    });
  });
};

exports.loginUserToRequest = async (req, user) => {
  if (!req || !user?._id || !user.email) {
    throw new Error("A valid account is required to establish a session.");
  }

  const currentUser = await User.findById(user._id)
    .select("-password");

  if (
    !currentUser ||
    !SIGN_IN_PERMITTED_STATUSES.has(currentUser.accountStatus) ||
    currentUser.email !== user.email ||
    currentUser.email.endsWith("@closed.loqum.invalid")
  ) {
    throw new Error("This account is not currently permitted to sign in.");
  }

  return new Promise((resolve, reject) => {
    req.login(currentUser, (err) => {
      if (err) return reject(err);

      return resolve();
    });
  });
};

exports.logoutRequest = (req) => {
  return new Promise((resolve, reject) => {
    req.logout((err) => {
      if (err) return reject(err);

      return resolve();
    });
  });
};

exports.destroySessionAndRedirect = (req, res, next, redirectTo) => {
  return req.session.destroy((err) => {
    if (err) return next(err);

    res.clearCookie("connect.sid");
    return res.redirect(redirectTo);
  });
};

exports.getSessionUser = (user) => {
  if (!user || user.accountStatus === "closed") {
    return null;
  }

  return {
    _id: user._id,
    firstName: user.firstName,
    lastName: user.lastName,
    displayName: user.displayName,
    legalNameSource: user.legalNameSource,
    email: user.email,
    photo: user.photo,
    role: user.role,
    authProvider: user.authProvider,
    accountStatus: user.accountStatus,
    isVerified: user.isVerified,
    isOnboarded: user.isOnboarded,
    twoFactorEnabled: user.twoFactorEnabled,
    professionalProfile: user.professionalProfile,
    employerProfile: user.employerProfile,
  };
};

exports.getCurrentUser = (req) => {
  if (
    !req ||
    typeof req.isAuthenticated !== "function" ||
    !req.isAuthenticated() ||
    !req.user ||
    req.user.accountStatus === "closed"
  ) {
    return null;
  }

  return req.user;
};

exports.refreshSessionUser = async (req, user) => {
  if (!req?.session || !user?._id || !req.user?._id) {
    return;
  }

  if (
    typeof req.isAuthenticated !== "function" ||
    !req.isAuthenticated()
  ) {
    return;
  }

  if (String(req.user._id) !== String(user._id)) {
    throw new Error("Session identity cannot be replaced.");
  }

  // A closed account cannot retain a usable session snapshot.

  if (user.accountStatus === "closed") {
    delete req.session.user;
    delete req.session.otpContext;

    req.user.accountStatus = "closed";

    await exports.saveSession(req);

    return;
  }

  if (req.user.accountStatus === "closed") {
    throw new Error("A closed session cannot be restored.");
  }

  req.session.user = exports.getSessionUser(user);

  req.user.firstName = user.firstName;
  req.user.lastName = user.lastName;
  req.user.displayName = user.displayName;
  req.user.legalNameSource = user.legalNameSource;
  req.user.email = user.email;
  req.user.photo = user.photo;
  req.user.authProvider = user.authProvider;
  req.user.accountStatus = user.accountStatus;
  req.user.isVerified = user.isVerified;
  req.user.isOnboarded = user.isOnboarded;
  req.user.twoFactorEnabled = user.twoFactorEnabled;
  req.user.role = user.role;
  req.user.professionalProfile = user.professionalProfile;
  req.user.employerProfile = user.employerProfile;

  await exports.saveSession(req);
};
