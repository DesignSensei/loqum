// public/js/employer/job-list.js

"use strict";

var EmployerJobList = (function () {
  function initialize() {
    var search = document.getElementById("job-search");

    if (search?.form && window.FormControls) {
      FormControls.init(search.form, { selects: "select" });
    }
  }

  return { init: initialize };
})();

KTUtil.onDOMContentLoaded(function () {
  EmployerJobList.init();
});
