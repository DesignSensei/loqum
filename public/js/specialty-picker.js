// public/js/specialty-picker.js

"use strict";

const SpecialtyPicker = (function () {
  const handleSpecialtyMapping = (typeSelector, specialtySelector) => {
    const specialtySelect = document.querySelector(specialtySelector);
    if (!specialtySelect) return;

    const data = window.specialtyConfig || {};

    function updateSpecialties(type) {
      const specialties = data[type] || [];

      // Clear existing options
      specialtySelect.innerHTML = '<option value="">Select Specialty</option>';

      // Populate with specialties for selected type
      specialties.forEach(function (specialty) {
        const option = new Option(specialty, specialty);
        specialtySelect.add(option);
      });

      // Enable or disable based on whether specialties exist
      specialtySelect.disabled = specialties.length === 0;

      // Re-initialise Select2 if active
      if (typeof $ !== "undefined" && $(specialtySelect).data("select2")) {
        $(specialtySelect).trigger("change.select2");
      }
    }

    // Listen for profession type card changes
    document.querySelectorAll(typeSelector).forEach(function (radio) {
      radio.addEventListener("change", function () {
        updateSpecialties(this.value);
      });
    });

    // Set initial state on load from default checked radio
    const defaultRadio = document.querySelector(`${typeSelector}:checked`);
    if (defaultRadio) updateSpecialties(defaultRadio.value);
  };

  return {
    init: function (typeSelector = 'input[name="type"]', specialtySelector = "#specialtySelect") {
      handleSpecialtyMapping(typeSelector, specialtySelector);
    },
  };
})();
