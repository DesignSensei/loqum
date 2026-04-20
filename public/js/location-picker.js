"use strict";

const LocationPicker = (function () {
  const handleLocationMapping = (stateSelector, lgaSelector) => {
    const stateSelect = document.querySelector(stateSelector);
    const lgaSelect = document.querySelector(lgaSelector);

    if (!stateSelect || !lgaSelect) return;

    const data = window.locationData || [];

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
    });
  };

  return {
    init: function (
      stateSelector = '[name="state"]',
      lgaSelector = '[name="lga"]',
    ) {
      handleLocationMapping(stateSelector, lgaSelector);
    },
  };
})();
