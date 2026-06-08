// config/countries.js

exports.COUNTRIES = {
  // --- LAUNCH COUNTRY ---

  NG: {
    code: "NG",
    name: "Nigeria",
    currency: "NGN",
    phoneCode: "+234",
  },

  // --- AFRICA ---

  GH: {
    code: "GH",
    name: "Ghana",
    currency: "GHS",
    phoneCode: "+233",
  },

  KE: {
    code: "KE",
    name: "Kenya",
    currency: "KES",
    phoneCode: "+254",
  },

  ZA: {
    code: "ZA",
    name: "South Africa",
    currency: "ZAR",
    phoneCode: "+27",
  },

  RW: {
    code: "RW",
    name: "Rwanda",
    currency: "RWF",
    phoneCode: "+250",
  },

  UG: {
    code: "UG",
    name: "Uganda",
    currency: "UGX",
    phoneCode: "+256",
  },

  TZ: {
    code: "TZ",
    name: "Tanzania",
    currency: "TZS",
    phoneCode: "+255",
  },

  EG: {
    code: "EG",
    name: "Egypt",
    currency: "EGP",
    phoneCode: "+20",
  },

  MA: {
    code: "MA",
    name: "Morocco",
    currency: "MAD",
    phoneCode: "+212",
  },

  CI: {
    code: "CI",
    name: "Côte d'Ivoire",
    currency: "XOF",
    phoneCode: "+225",
  },

  SN: {
    code: "SN",
    name: "Senegal",
    currency: "XOF",
    phoneCode: "+221",
  },

  CM: {
    code: "CM",
    name: "Cameroon",
    currency: "XAF",
    phoneCode: "+237",
  },

  // --- EUROPE / DIASPORA MARKETS ---

  GB: {
    code: "GB",
    name: "United Kingdom",
    currency: "GBP",
    phoneCode: "+44",
  },

  IE: {
    code: "IE",
    name: "Ireland",
    currency: "EUR",
    phoneCode: "+353",
  },

  DE: {
    code: "DE",
    name: "Germany",
    currency: "EUR",
    phoneCode: "+49",
  },

  FR: {
    code: "FR",
    name: "France",
    currency: "EUR",
    phoneCode: "+33",
  },

  NL: {
    code: "NL",
    name: "Netherlands",
    currency: "EUR",
    phoneCode: "+31",
  },

  ES: {
    code: "ES",
    name: "Spain",
    currency: "EUR",
    phoneCode: "+34",
  },

  IT: {
    code: "IT",
    name: "Italy",
    currency: "EUR",
    phoneCode: "+39",
  },

  // --- NORTH AMERICA ---

  US: {
    code: "US",
    name: "United States",
    currency: "USD",
    phoneCode: "+1",
  },

  CA: {
    code: "CA",
    name: "Canada",
    currency: "CAD",
    phoneCode: "+1",
  },

  // --- MIDDLE EAST ---

  AE: {
    code: "AE",
    name: "United Arab Emirates",
    currency: "AED",
    phoneCode: "+971",
  },

  SA: {
    code: "SA",
    name: "Saudi Arabia",
    currency: "SAR",
    phoneCode: "+966",
  },

  QA: {
    code: "QA",
    name: "Qatar",
    currency: "QAR",
    phoneCode: "+974",
  },

  // --- ASIA / PACIFIC ---

  IN: {
    code: "IN",
    name: "India",
    currency: "INR",
    phoneCode: "+91",
  },

  PK: {
    code: "PK",
    name: "Pakistan",
    currency: "PKR",
    phoneCode: "+92",
  },

  PH: {
    code: "PH",
    name: "Philippines",
    currency: "PHP",
    phoneCode: "+63",
  },

  AU: {
    code: "AU",
    name: "Australia",
    currency: "AUD",
    phoneCode: "+61",
  },

  NZ: {
    code: "NZ",
    name: "New Zealand",
    currency: "NZD",
    phoneCode: "+64",
  },
};

/* ---------- Defaults ---------- */

exports.DEFAULT_COUNTRY_CODE = "NG";
exports.DEFAULT_CURRENCY = "NGN";

/* ---------- Helpers ---------- */

exports.getCountryByCode = (countryCode) => {
  if (!countryCode) return null;

  return exports.COUNTRIES[String(countryCode).toUpperCase()] || null;
};

exports.getCurrencyForCountry = (countryCode) => {
  const country = exports.getCountryByCode(countryCode);

  return country ? country.currency : null;
};

exports.getCountryPhoneCode = (countryCode) => {
  const country = exports.getCountryByCode(countryCode);

  return country ? country.phoneCode : null;
};

exports.getAllCountries = () => {
  return Object.values(exports.COUNTRIES);
};

exports.getSupportedCurrenciesFromCountries = (countryCodes = []) => {
  const currencies = countryCodes
    .map((countryCode) => exports.getCurrencyForCountry(countryCode))
    .filter(Boolean);

  return [...new Set(currencies)];
};
