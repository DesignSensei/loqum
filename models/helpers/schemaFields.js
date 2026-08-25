// models/helpers/schemaFields.js

const isNonNegativeSafeInteger = (value) =>
  value === null || value === undefined || (Number.isSafeInteger(value) && value >= 0);

exports.minorUnitAmountField = ({ required = false, defaultValue, select } = {}) => {
  const field = {
    type: Number,
    required,
    min: 0,
    validate: {
      validator: isNonNegativeSafeInteger,
      message: ({ path }) => `${path} must be a non-negative whole number in minor units.`,
    },
  };

  if (defaultValue !== undefined) {
    field.default = defaultValue;
  }

  if (typeof select === "boolean") {
    field.select = select;
  }

  return field;
};

exports.nonNegativeIntegerField = ({ required = false, defaultValue = 0 } = {}) => ({
  type: Number,
  required,
  default: defaultValue,
  min: 0,
  validate: {
    validator: isNonNegativeSafeInteger,
    message: ({ path }) => `${path} must be a non-negative whole number.`,
  },
});

exports.positiveSafeIntegerField = ({ defaultValue, required = true, minimum = 1 } = {}) => {
  const field = {
    type: Number,
    required,
    min: minimum,
    validate: {
      validator: Number.isSafeInteger,
      message: "Value must be a safe whole number.",
    },
  };

  if (defaultValue !== undefined) {
    field.default = defaultValue;
  }

  return field;
};

exports.requiredPositiveSafeIntegerField = ({ label, maximum = null }) => {
  const field = {
    type: Number,
    required: true,
    min: [1, `${label} must be at least 1.`],
    validate: {
      validator: Number.isSafeInteger,
      message: `${label} must be a safe whole number.`,
    },
  };

  if (Number.isSafeInteger(maximum)) {
    field.max = [maximum, `${label} cannot exceed ${maximum}.`];
  }

  return field;
};

exports.requiredPositiveMinorUnitAmountField = (label) => ({
  type: Number,
  required: true,
  min: [1, `${label} must be at least 1 minor unit.`],
  validate: {
    validator: Number.isSafeInteger,
    message: `${label} must be a safe whole-number minor-unit amount.`,
  },
});

exports.requiredUniqueEnumArrayField = ({
  values,
  immutable = false,
  message = "Values must contain one or more unique valid items.",
}) => ({
  type: [
    {
      type: String,
      enum: values,
    },
  ],
  required: true,
  default: undefined,
  immutable,
  validate: {
    validator: (items) =>
      Array.isArray(items) &&
      items.length > 0 &&
      items.length <= values.length &&
      new Set(items).size === items.length,
    message,
  },
});
