// public/js/location-picker.js

"use strict";

const LocationPicker = (function () {
  const handleLocationMapping = (stateSelector, lgaSelector) => {
    const stateSelect = document.querySelector(stateSelector);
    const lgaSelect = document.querySelector(lgaSelector);

    if (!stateSelect || !lgaSelect) return;

    const data = Array.isArray(window.locations) ? window.locations : [];

    // Populate state options dynamically
    data.forEach(function (item) {
      const option = new Option(item.state, item.state);
      stateSelect.add(option);
    });

    // Re-initialise Select2 after populating
    if (typeof $ !== "undefined" && $(stateSelect).data("select2")) {
      $(stateSelect).trigger("change.select2");
    }

    // Handle state change → populate LGAs
    const handleStateChange = function () {
      const selectedState = stateSelect.value;
      const foundState = data.find((s) => s.state === selectedState);

      /*
       * Respect disabled State controls.
       *
       * :disabled detects controls disabled
       * directly or through a parent fieldset.
       *
       * The location picker must not enable
       * an LGA selector when its State selector
       * is read-only through a disabled fieldset.
       *
       * Programmatic selection must still work
       * so saved State/LGA values can be shown
       * to users with view-only access.
       */

      const stateIsDisabled = stateSelect.matches(":disabled");

      lgaSelect.innerHTML = '<option value="">Select LGA</option>';

      if (foundState && Array.isArray(foundState.lgas)) {
        foundState.lgas.forEach((lga) => {
          const option = new Option(lga, lga);
          lgaSelect.add(option);
        });

        lgaSelect.disabled = stateIsDisabled;
      } else {
        lgaSelect.disabled = true;
      }

      // Refresh Select2 without enabling disabled controls
      if (typeof $ !== "undefined" && $(lgaSelect).data("select2")) {
        $(lgaSelect).trigger("change.select2");
      }
    };

    /*
     * Support both jQuery-triggered changes
     * used by existing Loqum scripts and
     * native browser change events when
     * jQuery is unavailable.
     */

    if (typeof $ !== "undefined") {
      $(stateSelect).on("change", handleStateChange);
    } else {
      stateSelect.addEventListener("change", handleStateChange);
    }
  };

  return {
    init: function (stateSelector = '[name="state"]', lgaSelector = '[name="lga"]') {
      handleLocationMapping(stateSelector, lgaSelector);
    },
  };
})();
