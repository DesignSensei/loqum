// public/js/employer/job-create.js

"use strict";

var EmployerJobCreate = (function () {
  /* ─────────────────────────────── VALIDATION ─────────────────────────────── */

  function fail(message) {
    throw new Error(message);
  }

  function toMinorUnits(value, decimals) {
    var text = String(value).trim();

    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) {
      fail("The currency precision is unavailable. Reload the page.");
    }

    if (!/^\d+(?:\.\d+)?$/.test(text)) {
      fail("Enter a positive salary without commas or currency symbols.");
    }

    var [whole, fraction = ""] = text.split(".");

    if (fraction.length > decimals) {
      fail(`Use no more than ${decimals} decimal places for this currency.`);
    }

    var amount = BigInt(whole + fraction.padEnd(decimals, "0"));

    if (amount < 1n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail("The salary must be positive and within the supported amount range.");
    }

    return Number(amount);
  }

  function wholeNumber(value, minimum, label) {
    var text = String(value).trim();
    var number = Number(text);

    if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number < minimum) {
      fail(`${label} must be a whole number of at least ${minimum}.`);
    }

    return number;
  }

  function textLines(value, itemLimit, countLimit, label) {
    var items = String(value)
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);

    if (items.length > countLimit || items.some((item) => item.length > itemLimit)) {
      fail(`${label}: use at most ${countLimit} items and ${itemLimit} characters per item.`);
    }

    return items;
  }

  function numericCriterion(value) {
    if (String(value).trim() === "") return null;

    var number = Number(value);

    if (!Number.isFinite(number)) fail("Qualifying values must be finite numbers.");

    return number;
  }

  function screeningQuestion(raw, optionLimit, promptLimit) {
    var question = {
      prompt: raw.prompt.trim(),
      type: raw.type,
      requirementLevel: raw.requirementLevel,
      isResponseRequired: raw.isResponseRequired === true,
      options: [],
      acceptableOptions: [],
      qualifyingBoolean: null,
      minimumNumber: null,
      maximumNumber: null,
      requireAllOptions: false,
    };

    if (!question.prompt || question.prompt.length > promptLimit) {
      fail(`Enter a question of up to ${promptLimit} characters, or remove it.`);
    }

    if (
      !["yes_no", "number", "single_select", "multi_select", "short_text"].includes(
        question.type
      ) ||
      !["informational", "preferred", "required"].includes(question.requirementLevel)
    ) {
      fail("Choose a supported answer type and criterion.");
    }

    var criterion = question.requirementLevel !== "informational";
    var select = ["single_select", "multi_select"].includes(question.type);

    if (select) {
      // The supplied model does not impose an option-count limit.
      question.options = textLines(raw.options, optionLimit, Infinity, "Answer options");

      if (
        question.options.length < 2 ||
        new Set(question.options).size !== question.options.length
      ) {
        fail("Provide at least two different answer options.");
      }

      if (criterion) {
        question.acceptableOptions = textLines(
          raw.acceptableOptions,
          optionLimit,
          Infinity,
          "Qualifying options"
        );

        if (
          !question.acceptableOptions.length ||
          new Set(question.acceptableOptions).size !== question.acceptableOptions.length ||
          question.acceptableOptions.some((option) => !question.options.includes(option))
        ) {
          fail("Qualifying options must be unique and match the answer options exactly.");
        }

        question.requireAllOptions =
          question.type === "multi_select" && raw.requireAllOptions === true;
      }
    }

    if (criterion && question.type === "yes_no") {
      if (!["true", "false"].includes(raw.qualifyingBoolean))
        fail("Choose the qualifying yes/no answer.");
      question.qualifyingBoolean = raw.qualifyingBoolean === "true";
    }

    if (criterion && question.type === "number") {
      question.minimumNumber = numericCriterion(raw.minimumNumber);
      question.maximumNumber = numericCriterion(raw.maximumNumber);

      if (question.minimumNumber === null && question.maximumNumber === null) {
        fail("Provide a minimum or maximum qualifying value.");
      }

      if (
        question.minimumNumber !== null &&
        question.maximumNumber !== null &&
        question.maximumNumber < question.minimumNumber
      ) {
        fail("The maximum qualifying value cannot be below the minimum.");
      }
    }

    return question;
  }

  /* ─────────────────────────────── FORM ─────────────────────────────── */

  function initialize() {
    var form = document.getElementById("job-create-form");
    if (!form || form.dataset.initialized === "true") return;

    var byId = (id) => document.getElementById(id);
    var fields = byId("job-create-fields");
    var feedback = byId("job-create-feedback");
    var save = byId("job-save-draft");
    var list = byId("job-screening-questions");
    var template = byId("job-screening-question-template");
    var add = byId("job-add-question");
    var compensationToggle = byId("job-include-compensation");
    var decimals = Number(form.dataset.currencyDecimals);
    var maxQuestions = Number(form.dataset.maxQuestions);
    var maxItems = Number(form.dataset.maxListItems);
    var busy = false;
    var finished = false;
    var sequence = 0;

    var input = (name) => form.elements.namedItem(name);
    var value = (name) => input(name).value.trim();
    var questionRows = () => [...list.querySelectorAll("[data-screening-question]")];

    function showMessage(message, kind, showJobsLink = false) {
      feedback.replaceChildren();
      feedback.className = `alert alert-${kind} mb-0`;
      feedback.hidden = false;
      feedback.appendChild(document.createTextNode(message));

      if (showJobsLink) {
        var link = document.createElement("a");
        link.href = form.dataset.jobsUrl;
        link.className = "d-inline-block ms-3 fw-bold";
        link.textContent = "View jobs";
        feedback.appendChild(link);
      }

      feedback.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }

    function showGroup(element, visible) {
      element.hidden = !visible;
      element.querySelectorAll("input, select, textarea").forEach((control) => {
        control.disabled = !visible;
      });
    }

    function updateCompensation() {
      var enabled = compensationToggle.checked;
      var range = byId("job-compensation-type").value === "range";
      showGroup(byId("job-compensation-fields"), enabled);
      showGroup(byId("job-maximum-amount-group"), enabled && range);
      byId("job-minimum-amount").required = enabled;
      byId("job-maximum-amount").required = enabled && range;
      byId("job-minimum-amount-label").textContent =
        `${range ? "Minimum salary" : "Salary"} (${form.dataset.currency})`;
    }

    function updateQuestion(row) {
      var type = row.querySelector('[data-field="type"]').value;
      var criterion =
        row.querySelector('[data-field="requirementLevel"]').value !== "informational";
      var select = ["single_select", "multi_select"].includes(type);

      for (var [name, visible] of [
        ["options", select],
        ["boolean", criterion && type === "yes_no"],
        ["numbers", criterion && type === "number"],
        ["acceptable", criterion && select],
        ["all-options", criterion && type === "multi_select"],
      ])
        showGroup(row.querySelector(`[data-question-${name}]`), visible);
    }

    function renumberQuestions() {
      questionRows().forEach((row, index) => {
        row.querySelector("[data-question-title]").textContent = `Question ${index + 1}`;
        row
          .querySelector("[data-remove-question]")
          .setAttribute("aria-label", `Remove question ${index + 1}`);
      });
      add.disabled = questionRows().length >= maxQuestions;
    }

    add.addEventListener("click", () => {
      if (busy || finished || questionRows().length >= maxQuestions) return;
      var row = template.content.firstElementChild.cloneNode(true);
      sequence += 1;
      row.querySelectorAll("[data-field]").forEach((control) => {
        control.id = `job-question-${sequence}-${control.dataset.field}`;
      });
      row.addEventListener("change", () => updateQuestion(row));
      row.querySelector("[data-remove-question]").addEventListener("click", () => {
        if (busy || finished) return;
        row.remove();
        renumberQuestions();
        add.focus();
      });
      list.appendChild(row);
      updateQuestion(row);
      renumberQuestions();
      row.querySelector('[data-field="prompt"]').focus();
    });

    compensationToggle.addEventListener("change", updateCompensation);
    byId("job-compensation-type").addEventListener("change", updateCompensation);

    function buildPayload() {
      var payload = {};
      for (var name of [
        "branch",
        "roleTitle",
        "professionalType",
        "specialty",
        "department",
        "employmentType",
        "workplaceType",
        "educationRequirement",
        "summary",
        "description",
      ]) {
        var text = value(name);
        if (text) payload[name] = text;
      }
      payload.minimumYearsOfExperience = wholeNumber(
        value("minimumYearsOfExperience"),
        0,
        "Experience"
      );
      payload.vacancyCount = wholeNumber(value("vacancyCount"), 1, "Vacancies");

      form.querySelectorAll("[data-list-field]").forEach((control) => {
        payload[control.name] = textLines(
          control.value,
          Number(control.dataset.itemLimit),
          maxItems,
          control.name
        );
      });

      if (value("employmentStartDate")) {
        // A calendar date is transported as UTC midnight, without a local-time shift.
        payload.employmentStartDate = new Date(
          `${value("employmentStartDate")}T00:00:00.000Z`
        ).toISOString();
      }
      if (value("applicationDeadline")) {
        // datetime-local deliberately uses the user's device timezone.
        payload.applicationDeadline = new Date(value("applicationDeadline")).toISOString();
      }

      if (compensationToggle.checked) {
        var type = value("compensationType");
        var minimumAmount = toMinorUnits(value("minimumAmountDisplay"), decimals);
        var maximumAmount =
          type === "fixed" ? minimumAmount : toMinorUnits(value("maximumAmountDisplay"), decimals);
        if (maximumAmount < minimumAmount) fail("The maximum salary cannot be below the minimum.");
        payload.compensation = {
          type,
          minimumAmount,
          maximumAmount,
          period: value("compensationPeriod"),
          negotiable: input("negotiable").checked,
        };
      }

      var rows = questionRows();
      if (rows.length > maxQuestions) fail(`Use at most ${maxQuestions} screening questions.`);
      payload.screeningQuestions = rows.map((row, index) => {
        var raw = {};
        row.querySelectorAll("[data-field]").forEach((control) => {
          raw[control.dataset.field] =
            control.type === "checkbox" ? control.checked : control.value;
        });
        try {
          return screeningQuestion(
            raw,
            Number(row.querySelector('[data-field="options"]').dataset.itemLimit),
            row.querySelector('[data-field="prompt"]').maxLength
          );
        } catch (error) {
          row.querySelector('[data-field="prompt"]').focus();
          fail(`Question ${index + 1}: ${error.message}`);
        }
      });

      payload._csrf = value("_csrf");
      return payload;
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy || finished || !form.reportValidity()) return;

      var payload;
      try {
        payload = buildPayload();
        if (!payload._csrf)
          fail("Your session token is unavailable. Reload the page before saving.");
      } catch (error) {
        showMessage(error.message, "danger");
        return;
      }

      busy = true;
      fields.disabled = true;
      save.textContent = "Saving…";
      form.setAttribute("aria-busy", "true");
      save.setAttribute("data-kt-indicator", "on");

      try {
        var response = await axios.post(form.action, payload, {
          headers: {
            Accept: "application/json",
            "CSRF-Token": payload._csrf,
          },
          validateStatus: function () {
            return true;
          },
        });

        var result = response.data;
        var successfulStatus = response.status >= 200 && response.status < 300;

        if (successfulStatus && result?.success === true) {
          finished = true;
          showMessage(
            "Draft saved. It has not been published and no payment was taken.",
            "success",
            true
          );
        } else if (response.status >= 400 && response.status < 500) {
          showMessage(
            result?.message ||
              "The draft could not be saved. Check your session and submitted details.",
            "danger"
          );
        } else {
          // Draft creation has no idempotency key. An unclear response must not
          // automatically repeat a POST that may already have created a draft.
          finished = true;
          showMessage(
            "We could not confirm whether the draft was saved. Check your jobs before creating another draft.",
            "warning",
            true
          );
        }
      } catch {
        finished = true;
        showMessage(
          "The connection was interrupted. Check your jobs to see whether the draft was saved before trying again.",
          "warning",
          true
        );
      } finally {
        busy = false;
        fields.disabled = finished;
        save.textContent = finished ? "Check your jobs" : "Save draft";
        form.removeAttribute("aria-busy");
        save.removeAttribute("data-kt-indicator");
      }
    });

    if (typeof axios === "undefined") {
      showMessage("The form could not load. Refresh the page before saving.", "danger");
      return;
    }

    updateCompensation();
    renumberQuestions();
    form.dataset.initialized = "true";
    fields.disabled = false;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { toMinorUnits, wholeNumber, textLines, screeningQuestion };
  }

  return {
    init: function () {
      initialize();
    },
  };
})();

if (typeof document !== "undefined") {
  KTUtil.onDOMContentLoaded(function () {
    EmployerJobCreate.init();
  });
}
