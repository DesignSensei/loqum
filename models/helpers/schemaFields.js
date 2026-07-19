// models/helpers/schemaFields.js

const isNonNegativeSafeInteger = (value) =>
  value === null || value === undefined || (Number.isSafeInteger(value) && value >= 0);

const minorUnitAmountField = ({ required = false, defaultValue = null, select } = {}) => {
  const field = {
    type: Number,
    required,
    default: defaultValue,
    min: 0,
    validate: {
      validator: isNonNegativeSafeInteger,
      message: ({ path }) => `${path} must be a non-negative whole number in minor units.`,
    },
  };

  if (typeof select === "boolean") {
    field.select = select;
  }

  return field;
};

const nonNegativeIntegerField = ({ required = false, defaultValue = 0 } = {}) => ({
  type: Number,
  required,
  default: defaultValue,
  min: 0,
  validate: {
    validator: isNonNegativeSafeInteger,
    message: ({ path }) => `${path} must be a non-negative whole number.`,
  },
});

module.exports = {
  minorUnitAmountField,
  nonNegativeIntegerField,
};
