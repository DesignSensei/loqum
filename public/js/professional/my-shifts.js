// public/js/professional/my-shifts.js

"use strict";

var ProfessionalMyShifts = (function () {
  var navigationLinks = [];

  // ───────────────────── NAVIGATION LOADING STATE ─────────────────────

  function setNavigationLoading(link) {
    if (!link || link.getAttribute("aria-busy") === "true") return;

    link.setAttribute("aria-busy", "true");
    link.classList.add("opacity-75");

    var spinner = document.createElement("span");

    spinner.className = "spinner-border spinner-border-sm ms-2";
    spinner.setAttribute("aria-hidden", "true");
    spinner.setAttribute("data-my-shifts-spinner", "");

    link.appendChild(spinner);
  }

  function clearNavigationLoading() {
    navigationLinks.forEach(function (link) {
      link.removeAttribute("aria-busy");
      link.classList.remove("opacity-75");

      var spinner = link.querySelector("[data-my-shifts-spinner]");

      if (spinner) {
        spinner.remove();
      }
    });
  }

  // ───────────────────── NAVIGATION EVENTS ─────────────────────

  function isStandardNavigation(event, link) {
    if (event.defaultPrevented) return false;

    if (event.button !== 0) return false;

    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return false;
    }

    if (!link || !link.getAttribute("href")) return false;

    if (link.getAttribute("aria-current") === "page") return false;

    if (link.hasAttribute("download")) return false;

    if (link.target && link.target !== "_self") return false;

    return true;
  }

  function bindNavigation() {
    navigationLinks = Array.from(
      document.querySelectorAll(
        'nav[aria-label="My Shifts categories"] a.nav-link, ' +
          'nav[aria-label="My Shifts pagination"] a.page-link'
      )
    );

    navigationLinks.forEach(function (link) {
      link.addEventListener("click", function (event) {
        if (!isStandardNavigation(event, link)) return;

        // Keep native GET navigation.
        // The backend controls tabs, filtering and pagination.
        setNavigationLoading(link);
      });
    });

    // Restore links when returning through browser history.
    window.addEventListener("pageshow", function () {
      clearNavigationLoading();
    });
  }

  // ───────────────────── INITIALISATION ─────────────────────

  function initializeMyShifts() {
    var tabs = document.querySelector('nav[aria-label="My Shifts categories"]');

    if (!tabs) return;

    bindNavigation();
  }

  return {
    init: function () {
      initializeMyShifts();
    },
  };
})();

KTUtil.onDOMContentLoaded(function () {
  ProfessionalMyShifts.init();
});
