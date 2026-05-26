// config/policy.js

module.exports = {
  commission: {
    newcomer: 0.075,
    accredited: 0.0625,
    elite: 0.05,
  },

  activeShiftLimit: {
    newcomer: 1,
    accredited: 3,
    elite: Infinity,
  },
};
