// public/js/location-picker.js

"use strict";

const LocationPicker = (function () {
  const handleLocationMapping = (stateSelector, lgaSelector) => {
    const stateSelect = document.querySelector(stateSelector);
    const lgaSelect = document.querySelector(lgaSelector);

    if (!stateSelect || !lgaSelect) return;

    const data = window.locations || [];

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
    $(stateSelect).on("change", function () {
      const selectedState = this.value;
      const foundState = data.find((s) => s.state === selectedState);

      lgaSelect.innerHTML = '<option value="">Select LGA</option>';

      if (foundState && foundState.lgas) {
        foundState.lgas.forEach((lga) => {
          const option = new Option(lga, lga);
          lgaSelect.add(option);
        });
        lgaSelect.disabled = false;
      } else {
        lgaSelect.disabled = true;
      }

      // Re-initialise Select2
      if (typeof $ !== "undefined" && $(lgaSelect).data("select2")) {
        $(lgaSelect).trigger("change.select2");
      }
    });
  };

  return {
    init: function (stateSelector = '[name="state"]', lgaSelector = '[name="lga"]') {
      handleLocationMapping(stateSelector, lgaSelector);
    },
  };
})();
