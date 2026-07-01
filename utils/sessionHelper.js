// utils/sessionHelper.js

exports.saveSession = (req) => {
  return new Promise((resolve, reject) => {
    req.session.save((err) => {
      if (err) return reject(err);

      return resolve();
    });
  });
};

exports.loginUserToRequest = (req, user) => {
  return new Promise((resolve, reject) => {
    req.login(user, (err) => {
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
  return {
    _id: user._id,
    firstName: user.firstName,
    lastName: user.lastName,
    displayName: user.displayName,
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
  return req.user || req.session.user || null;
};

exports.refreshSessionUser = async (req, user) => {
  if (!req || !user) return;

  req.session.user = exports.getSessionUser(user);

  if (req.user) {
    req.user.firstName = user.firstName;
    req.user.lastName = user.lastName;
    req.user.displayName = user.displayName;
    req.user.email = user.email;
    req.user.photo = user.photo;
    req.user.authProvider = user.authProvider;
    req.user.accountStatus = user.accountStatus;
    req.user.isVerified = user.isVerified;
    req.user.isOnboarded = user.isOnboarded;
    req.user.twoFactorEnabled = user.twoFactorEnabled;
  }

  await exports.saveSession(req);
};
