// public/js/form-controls.js

"use strict";

var FormControls = (function () {
  var mounted = new WeakMap();
  var calendarId = 0;

  /**
   * Enhance only fields explicitly selected by a page or marked in its markup.
   * Call after restoring values and installing the page's change listeners.
   * Date restrictions and business rules remain the responsibility of the page.
   */
  function init(root, options) {
    root = root || document;
    options = options || {};

    if (mounted.has(root)) {
      mounted.get(root).refresh();
      return mounted.get(root);
    }

    var selectSelector = options.selects || 'select[data-control="select2"]';
    var dateSelector = options.dates || 'input[data-control="datepicker"]';
    var namespace = ".loqumFormControls";
    var selects = new Map();
    var calendars = new Map();

    function isDisabled(element) {
      return element.matches(":disabled");
    }

    function initializeSelect(element) {
      if (selects.has(element) || !window.jQuery?.fn.select2) {
        return;
      }

      var select = window.jQuery(element);
      var parent = element.closest(".menu-sub-dropdown, .modal");
      var emptyOption = element.querySelector('option[value=""]');

      if (!select.data("select2")) {
        select.select2({
          width: "100%",
          dropdownParent: window.jQuery(parent || document.body),
          placeholder: emptyOption ? emptyOption.textContent.trim() : undefined,
          allowClear: Boolean(emptyOption),
          minimumResultsForSearch: element.options.length > 8 ? 0 : Infinity,
          disabled: isDisabled(element),
          ...(options.select2 || {}),
        });
      }

      selects.set(element, select);

      // Bridge plugin changes to native listeners registered by the page.
      select.on("change" + namespace, function (event) {
        if (event.isTrigger && !event.originalEvent) {
          element.dispatchEvent(new Event("change", { bubbles: true }));
        }

        if (element.validity.valid) {
          var selection = select.data("select2").$selection;
          selection.removeClass("is-invalid");
          selection.removeAttr("aria-invalid title");
        }
      });

      select.on("select2:opening" + namespace, function (event) {
        if (isDisabled(element)) {
          event.preventDefault();
        }
      });

      var invalidHandler = function (event) {
        event.preventDefault();
        var instance = select.data("select2");
        if (!instance) {
          return;
        }
        instance.$selection.addClass("is-invalid");
        instance.$selection.attr({
          "aria-invalid": "true",
          title: element.validationMessage,
        });
        if (!document.querySelector(".select2-container--open")) {
          instance.$selection[0].focus();
          select.select2("open");
        }
      };
      element.addEventListener("invalid", invalidHandler);
      select.data("loqumFormInvalidHandler", invalidHandler);
    }

    function initializeCalendar(element) {
      if (calendars.has(element) || !window.flatpickr) {
        return;
      }

      var includesTime = element.type === "datetime-local" || element.dataset.enableTime === "true";
      var originalValue = element.value;
      var picker =
        element._flatpickr ||
        window.flatpickr(element, {
          dateFormat: includesTime ? "Y-m-d\\TH:i" : "Y-m-d",
          altInput: true,
          altFormat: includesTime ? "F j, Y H:i" : "F j, Y",
          enableTime: includesTime,
          time_24hr: true,
          minuteIncrement: 1,
          disableMobile: true,
          allowInput: false,
          ...(includesTime ? options.dateTime : options.date),
          // Optional dates can be cleared without forcing a keyboard input format.
          onReady: function (dates, value, instance) {
            var clear = document.createElement("button");
            clear.type = "button";
            clear.className = "btn btn-sm btn-light w-100 mt-2";
            clear.textContent = "Clear date";
            clear.addEventListener("click", function () {
              if (!isDisabled(element)) {
                instance.clear();
                instance.close();
              }
            });
            instance.calendarContainer.appendChild(clear);
          },
        });

      // Initializing the widget must not rewrite the saved form value.
      element.value = originalValue;
      calendars.set(element, picker);

      if (picker.altInput) {
        var visibleId = element.id ? element.id + "-calendar" : "form-calendar-" + ++calendarId;
        while (document.getElementById(visibleId)) {
          visibleId = "form-calendar-" + ++calendarId;
        }
        picker.altInput.id = visibleId;
        picker.altInput.removeAttribute("name");
        var help = element.getAttribute("aria-describedby");
        if (help) {
          picker.altInput.setAttribute("aria-describedby", help);
        }
        document.querySelectorAll("label[for]").forEach(function (label) {
          if (element.id && label.htmlFor === element.id) {
            label.htmlFor = visibleId;
          }
        });
      }
    }

    function refresh(root) {
      root.querySelectorAll(selectSelector).forEach(initializeSelect);
      root.querySelectorAll(dateSelector).forEach(initializeCalendar);

      selects.forEach(function (select, element) {
        if (!element.isConnected) {
          element.removeEventListener("invalid", select.data("loqumFormInvalidHandler"));
          select.removeData("loqumFormInvalidHandler");
          select.off(namespace);
          if (select.data("select2")) {
            select.select2("destroy");
          }
          selects.delete(element);
          return;
        }

        var instance = select.data("select2");
        var disabled = isDisabled(element);
        // Select2 watches the select's own disabled attribute, not its fieldset.
        if (instance && instance.options.get("disabled") !== disabled) {
          instance.options.set("disabled", disabled);
          instance.trigger(disabled ? "disable" : "enable", {});
        }
        if (disabled && instance?.isOpen()) {
          select.select2("close");
        }
      });

      calendars.forEach(function (picker, element) {
        if (!element.isConnected) {
          picker.destroy();
          calendars.delete(element);
          return;
        }
        if (picker.altInput) {
          picker.altInput.disabled = isDisabled(element);
        }
        if (isDisabled(element)) {
          picker.close();
        }
      });
    }

    refresh(root);
    var observer = new MutationObserver(function (records) {
      var relevant = records.some(function (record) {
        if (record.type === "attributes") {
          return record.target.matches("select, fieldset") || calendars.has(record.target);
        }
        return Array.from(record.addedNodes)
          .concat(Array.from(record.removedNodes))
          .some(function (node) {
            return (
              node.nodeType === 1 &&
              (node.matches(selectSelector + ", " + dateSelector) ||
                node.querySelector(selectSelector + ", " + dateSelector) ||
                Array.from(calendars.keys()).some(function (input) {
                  return node === input || node.contains(input);
                }))
            );
          });
      });
      if (relevant) {
        refresh(root);
      }
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["disabled"],
    });
    var binding = {
      refresh: function () {
        refresh(root);
      },
    };
    mounted.set(root, binding);
    return binding;
  }

  return { init: init };
})();
