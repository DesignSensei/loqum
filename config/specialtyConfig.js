// config/specialtyConfig.js

const specialtyConfig = {
  pharmacist: ["Community", "Hospital", "Industrial", "Academic", "Administrative"],
  pharmacy_technician: ["Community", "Hospital", "Industrial"],
  nurse: [
    "General",
    "ICU / Critical Care",
    "Paediatrics",
    "Midwifery",
    "Psychiatric",
    "Surgical",
    "Oncology",
    "Emergency",
  ],
  doctor: [
    "General Practice",
    "Internal Medicine",
    "Surgery",
    "Paediatrics",
    "Obstetrics & Gynaecology",
    "Psychiatry",
    "Emergency Medicine",
    "Anaesthesia",
  ],
  lab_scientist: [
    "Chemical Pathology",
    "Haematology",
    "Medical Microbiology",
    "Histopathology",
    "Immunology",
  ],
  radiographer: ["Diagnostic", "Therapeutic", "Ultrasound", "MRI", "Nuclear Medicine"],
  physiotherapist: [
    "Orthopaedic",
    "Neurological",
    "Cardiopulmonary",
    "Paediatric",
    "Sports",
    "Geriatric",
  ],
};

module.exports = specialtyConfig;
