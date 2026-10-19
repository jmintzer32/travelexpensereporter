// Coupa Expense Filler
//
// Runs inside your Coupa tab and types the expense lines exported from the
// Travel Expense Reporter app into Coupa's expense line form, one Coupa
// report per trip.
//
// The same file is used two ways:
//   1. As a bookmarklet: the app wraps this whole file into a `javascript:` URL.
//   2. By the Chrome extension: popup.js injects it and calls
//      window.__coupaFiller.open(payload).
//
// Everything about *where* to type (selectors for Coupa's buttons and fields)
// lives in a config saved in this browser's localStorage for the Coupa site,
// editable from the panel's "Setup" tab (including a point-and-click picker).
// The defaults match Coupa's expense screen (its stable "s-..." classes).
// How you pick a project's cost code is learned once (see "Project cost codes").
// Everything about *what* to type (date format, expense category names,
// business purpose) is decided by the app before the data is copied.
//
// Selector syntax accepted in the config:
//   any CSS selector         e.g.  .s-lineMerchant
//   text:<button text>       e.g.  text:Add Expense Line
//   label:<label text>       e.g.  label:Merchant   (the field a <label> points to)
// Field selectors are looked up inside the open line form. When a selector
// matches several elements, the last visible one is used.
(function () {
  'use strict';

  var VERSION = '2.6.0';
  var CONFIG_KEY = 'coupaFiller.config.v2';
  var STATE_KEY = 'coupaFiller.state.v2';

  if (window.__coupaFiller && window.__coupaFiller.version === VERSION) {
    return;
  }
  if (window.__coupaFiller && window.__coupaFiller.destroy) {
    window.__coupaFiller.destroy();
  }

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  var BUTTONS = [
    ['createReport', '“Create” new report button'],
    ['editTitle', '“Edit” report title button'],
    ['addLine', '“Add Expense Line” button'],
    ['save', '“Save” button for a line']
  ];

  var DEFAULT_CONFIG = {
    createReport: 'button.s-createReport',
    editTitle: 'button.s-editReportTitleBtn',
    titleInput: '.titleWrapper input[type="text"], .titleWrapper textarea',
    reportTitle: '.s-readOnlyReportTitle',
    reportNumber: '.reportNum',
    addLine: 'button.s-addExpenseLine',
    save: 'button.s-saveLine',
    lineForm: 'form.s-editExpenseLineForm',
    // The line's Account (cost code) and Coupa's "Account search" window.
    account: {
      open: '.s-openAccountModal',
      current: '.s-accountName',
      modal: '[role="dialog"], .ui-dialog, .modal, [class*="Modal"]'
    },
    // In fill order. Category goes first: picking it can change the form.
    fields: [
      { key: 'expenseType', label: 'Expense Category', selector: '.s-lineCategory', kind: 'combobox', enabled: true, waitAfter: 1200 },
      { key: 'date', label: 'Expense Date', selector: '.s-lineExpenseDate', kind: 'text', enabled: true },
      { key: 'amount', label: 'Total', selector: '.s-lineAmount', kind: 'text', enabled: true },
      { key: 'currency', label: 'Currency', selector: '.s-lineCurrency', kind: 'combobox', enabled: false },
      { key: 'description', label: 'Description', selector: '.s-lineDescription', kind: 'text', enabled: true },
      { key: 'merchant', label: 'Merchant', selector: '.s-lineMerchant', kind: 'text', enabled: true },
      { key: 'purpose', label: 'Business Purpose', selector: '.s-lineReason', kind: 'text', enabled: true },
      { key: 'zipCode', label: 'Zip Code', selector: '.s-custom_field_2', kind: 'combobox', enabled: true }
    ],
    // Fallback for dropdown choices of type-ahead fields that don't say
    // (via aria-owns) where their choices are.
    optionSelector: '[role="option"], .select2-results__option, .ui-menu-item, .chosen-results li',
    // Click Coupa's Save after each line, so Fill next / Fill all keep going.
    saveEachLine: true,
    // Set each line's Account to its project while filling. When that fails,
    // the line is still saved and listed on the Cost codes tab.
    setCostCodes: true,
    delays: { afterAddLine: 1200, betweenFields: 250, afterSave: 2000, fieldTimeout: 8000 }
  };

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function storageGet(key) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      // Private window or blocked storage: the panel still works for this page.
    }
  }

  function mergeConfig(saved) {
    var cfg = clone(DEFAULT_CONFIG);
    if (!saved || typeof saved !== 'object') return cfg;
    Object.keys(cfg).forEach(function (k) {
      if (k !== 'fields' && k !== 'delays' && saved[k] !== undefined) cfg[k] = saved[k];
    });
    if (saved.delays) Object.keys(cfg.delays).forEach(function (k) {
      if (typeof saved.delays[k] === 'number') cfg.delays[k] = saved.delays[k];
    });
    if (Array.isArray(saved.fields)) {
      // Keep the saved order, then append any field this version added.
      var byKey = {};
      cfg.fields.forEach(function (f) { byKey[f.key] = f; });
      var fields = [];
      saved.fields.forEach(function (f) {
        if (f && byKey[f.key]) {
          fields.push(Object.assign({}, byKey[f.key], f));
          delete byKey[f.key];
        }
      });
      Object.keys(byKey).forEach(function (k) { fields.push(byKey[k]); });
      cfg.fields = fields;
    }
    return cfg;
  }

  var config = mergeConfig(storageGet(CONFIG_KEY));
  function saveConfig() { storageSet(CONFIG_KEY, config); }

  // state.trips: [{ title, startDate, endDate, report, project, lines: [{ line, status, error }] }]
  // status: 'pending' | 'filled' (waiting for you to save) | 'done' | 'skipped' | 'error'
  var state = storageGet(STATE_KEY) || { trips: [], trip: 0, current: 0 };
  function saveState() { storageSet(STATE_KEY, state); }
  function trip() { return state.trips[state.trip]; }
  function lines() { return trip() ? trip().lines : []; }

  // ---------------------------------------------------------------------------
  // Payload parsing
  // ---------------------------------------------------------------------------

  function parsePayload(input) {
    var data = input;
    if (typeof input === 'string') {
      var text = input.trim();
      if (!text) throw new Error('Nothing pasted.');
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error('That is not the data copied from Travel Expense Reporter. Use its "Copy for bookmarklet" button, then paste again.');
      }
    }
    if (!data || data.source !== 'travel-expense-reporter') {
      throw new Error('Unrecognized data. Use the "Copy for bookmarklet" button in Travel Expense Reporter.');
    }
    if (Array.isArray(data.trips)) return data.trips;
    if (Array.isArray(data.lines)) return [{ title: '', lines: data.lines }];
    throw new Error('The copied data has no trips.');
  }

  function loadTrips(trips) {
    state = {
      trips: trips.map(function (t) {
        return {
          title: t.title || '',
          startDate: t.startDate || '',
          endDate: t.endDate || '',
          report: '',
          project: t.project || null,
          lines: (t.lines || []).map(function (line) { return { line: line, status: 'pending', error: '' }; })
        };
      }),
      trip: 0,
      current: 0
    };
    saveState();
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.getClientRects().length === 0) return false;
    var style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function norm(text) {
    return String(text || '').replace(/\s+/g, ' ').replace(/\*/g, '').trim().toLowerCase();
  }

  function elementText(el) {
    if (el.tagName === 'INPUT') return el.value || el.getAttribute('aria-label') || '';
    return el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '';
  }

  var CLICKABLE = 'button, a, [role="button"], input[type="submit"], input[type="button"]';
  var FIELD = 'input:not([type="hidden"]), select, textarea, [contenteditable="true"], [role="combobox"]';

  function toArray(list) {
    return Array.prototype.slice.call(list);
  }

  function findAll(selector, scope) {
    scope = scope || document;
    if (!selector) return [];
    selector = selector.trim();
    if (selector.indexOf('text:') === 0) {
      var wanted = norm(selector.slice(5));
      var clickables = toArray(scope.querySelectorAll(CLICKABLE));
      var exact = clickables.filter(function (el) { return norm(elementText(el)) === wanted; });
      return exact.length ? exact : clickables.filter(function (el) { return norm(elementText(el)).indexOf(wanted) !== -1; });
    }
    if (selector.indexOf('label:') === 0) {
      var labelText = norm(selector.slice(6));
      var labels = toArray(scope.querySelectorAll('label'));
      var matches = labels.filter(function (l) { return norm(l.textContent) === labelText; });
      if (!matches.length) matches = labels.filter(function (l) { return norm(l.textContent).indexOf(labelText) === 0; });
      var out = [];
      matches.forEach(function (l) {
        var target = l.htmlFor ? document.getElementById(l.htmlFor) : l.querySelector(FIELD);
        if (!target && l.parentElement) target = l.parentElement.querySelector(FIELD);
        if (target) out.push(target);
      });
      return out;
    }
    try {
      return toArray(scope.querySelectorAll(selector));
    } catch (e) {
      throw new Error('Invalid selector: ' + selector);
    }
  }

  // Last visible match; hidden <select>s behind a styled dropdown still count.
  function resolve(selector, scope) {
    var all = findAll(selector, scope);
    var visible = all.filter(isVisible);
    if (visible.length) return visible[visible.length - 1];
    var selects = all.filter(function (el) { return el.tagName === 'SELECT'; });
    return selects.length ? selects[selects.length - 1] : null;
  }

  // getScope is re-evaluated on every poll, since Coupa may re-render the form.
  function waitFor(selector, timeout, getScope) {
    var start = Date.now();
    return new Promise(function (resolvePromise, reject) {
      (function poll() {
        var scope = getScope ? getScope() : document;
        var el = scope ? resolve(selector, scope) : null;
        if (el) return resolvePromise(el);
        if (Date.now() - start > timeout) return reject(new Error('Could not find ' + selector));
        setTimeout(poll, 150);
      })();
    });
  }

  async function waitUntil(test, timeout) {
    var start = Date.now();
    while (Date.now() - start < timeout) {
      if (test()) return true;
      await sleep(150);
    }
    return test();
  }

  function fire(el, type) {
    el.dispatchEvent(new Event(type, { bubbles: true }));
  }

  function key(el, type, k) {
    el.dispatchEvent(new KeyboardEvent(type, { key: k, code: k, bubbles: true, cancelable: true }));
  }

  function realClick(el) {
    el.scrollIntoView({ block: 'center' });
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function (t) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    });
    el.click();
  }

  // Sets a value so frameworks (React, Angular, jQuery) notice the change.
  function setNativeValue(el, value) {
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
  }

  function setText(el, value) {
    el.focus();
    if (el.isContentEditable) {
      el.textContent = value;
    } else {
      setNativeValue(el, value);
    }
    fire(el, 'input');
    fire(el, 'change');
    key(el, 'keyup', 'End');
    el.blur();
    fire(el, 'blur');
  }

  function setSelect(el, value) {
    var wanted = norm(value);
    var options = toArray(el.options);
    var match = options.filter(function (o) { return norm(o.text) === wanted || norm(o.value) === wanted; })[0]
      || options.filter(function (o) { return norm(o.text).indexOf(wanted) !== -1; })[0];
    if (!match) {
      throw new Error('"' + value + '" is not one of the choices. Fix the mapping in the app.');
    }
    setNativeValue(el, match.value);
    fire(el, 'input');
    fire(el, 'change');
    // jQuery-based dropdowns (select2/chosen) listen for jQuery's own event.
    var jq = window.jQuery || window.$;
    if (jq && jq.fn && jq.fn.trigger) {
      try { jq(el).trigger('change'); } catch (e) { /* not a jQuery widget */ }
    }
  }

  // The visible choices of a type-ahead, preferring the list it says it owns.
  function comboOptions(el) {
    var ids = [el.getAttribute('aria-owns'), el.getAttribute('aria-controls')].filter(Boolean);
    for (var i = 0; i < ids.length; i++) {
      var box = document.getElementById(ids[i]);
      if (!box) continue;
      var opts = toArray(box.querySelectorAll('[role="option"]'));
      if (!opts.length) opts = toArray(box.querySelectorAll('li'));
      opts = opts.filter(isVisible);
      if (opts.length) return opts;
    }
    return findAll(config.optionSelector).filter(isVisible);
  }

  function bestOption(options, value) {
    var wanted = norm(value);
    var texts = options.map(function (o) { return norm(elementText(o)); });
    var i = texts.indexOf(wanted);
    if (i === -1) i = texts.findIndex(function (t) { return t.indexOf(wanted) === 0; });
    if (i === -1) i = texts.findIndex(function (t) { return t.indexOf(wanted) !== -1; });
    return i === -1 ? null : options[i];
  }

  function typeInto(input, value) {
    input.focus();
    setNativeValue(input, value);
    fire(input, 'input');
    var last = value.slice(-1) || 'a';
    key(input, 'keydown', last);
    key(input, 'keyup', last);
  }

  // Coupa's ComboBox keeps the chosen id in a hidden input next to it.
  function hiddenValueOf(el) {
    var wrapper = el.closest('.ComboBox__field') || el.parentElement;
    var hidden = wrapper && wrapper.parentElement
      ? wrapper.parentElement.querySelector('input[type="hidden"]')
      : null;
    return hidden;
  }

  async function setCombobox(el, value) {
    var input = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el : el.querySelector('input');
    if (!input) throw new Error('No text box to type into.');
    realClick(input);
    typeInto(input, value);

    var match = null;
    var start = Date.now();
    while (!match && Date.now() - start < 5000) {
      await sleep(250);
      match = bestOption(comboOptions(input), value);
    }
    if (!match) {
      // Show what Coupa does offer, so the mapping in the app can be fixed.
      typeInto(input, '');
      await sleep(1200);
      var choices = comboOptions(input).slice(0, 25).map(function (o) { return elementText(o).trim(); }).filter(Boolean);
      typeInto(input, '');
      key(input, 'keydown', 'Escape');
      input.blur();
      throw new Error('no choice matching "' + value + '".' +
        (choices.length ? ' Coupa offers: ' + choices.join(', ') : ''));
    }
    realClick(match);
    await sleep(300);
    var hidden = hiddenValueOf(input);
    if (hidden && !hidden.value) {
      // The click didn't register as a selection; try the keyboard instead.
      typeInto(input, value);
      await sleep(800);
      key(input, 'keydown', 'ArrowDown');
      key(input, 'keydown', 'Enter');
      await sleep(300);
      if (!hidden.value) throw new Error('could not select "' + value + '". Pick it by hand, then continue.');
    }
  }

  function detectKind(el) {
    if (el.tagName === 'SELECT') return 'select';
    var role = el.getAttribute('role');
    var auto = el.getAttribute('aria-autocomplete');
    if (role === 'combobox' || (auto && auto !== 'none')) return 'combobox';
    return 'text';
  }

  async function setField(el, value, field) {
    var kind = field.kind === 'auto' ? detectKind(el) : field.kind;
    if (kind === 'select') return setSelect(el, value);
    if (kind === 'combobox') return setCombobox(el, value);
    return setText(el, value);
  }

  // ---------------------------------------------------------------------------
  // Coupa actions
  // ---------------------------------------------------------------------------

  function lineForm() {
    return config.lineForm ? resolve(config.lineForm) : document;
  }

  function fieldsToFill() {
    return config.fields.filter(function (f) { return f.enabled && f.selector; });
  }

  // True when the open line form has nothing typed into it yet.
  function formIsBlank(form) {
    return fieldsToFill().every(function (f) {
      var el = resolve(f.selector, form);
      if (!el || f.key === 'currency') return true;
      var v = String(el.value || '').trim();
      return v === '' || v === '0.00' || v === '0';
    });
  }

  function reportNumber() {
    var el = config.reportNumber ? resolve(config.reportNumber) : null;
    return el ? el.textContent.trim() : '';
  }

  async function createReport(title) {
    var before = reportNumber();
    realClick(await waitFor(config.createReport, config.delays.fieldTimeout));
    var changed = await waitUntil(function () {
      var now = reportNumber();
      return now && now !== before;
    }, 15000);
    if (!changed) throw new Error('Coupa didn’t open a new report. Click Create in Coupa, then use “Use open report”.');
    await sleep(800);
    var number = reportNumber();
    if (title) {
      try {
        await setReportTitle(title);
      } catch (e) {
        return { number: number, warning: 'Couldn’t name the report automatically (' + e.message + '). Rename it to “' + title + '” in Coupa.' };
      }
    }
    return { number: number, warning: '' };
  }

  async function setReportTitle(title) {
    realClick(await waitFor(config.editTitle, 4000));
    var input = await waitFor(config.titleInput, 4000).catch(function () {
      var active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return active;
      throw new Error('no title box appeared');
    });
    input.focus();
    setNativeValue(input, title);
    fire(input, 'input');
    fire(input, 'change');
    key(input, 'keydown', 'Enter');
    key(input, 'keyup', 'Enter');
    await sleep(400);
    if (input.isConnected) {
      input.blur();
      fire(input, 'blur');
    }
    var ok = await waitUntil(function () {
      var shown = config.reportTitle ? resolve(config.reportTitle) : null;
      return shown && norm(shown.textContent).indexOf(norm(title)) !== -1;
    }, 4000);
    if (!ok) throw new Error('the new title didn’t show up');
  }

  // ---------------------------------------------------------------------------
  // Project cost codes (the line's Account)
  // ---------------------------------------------------------------------------
  //
  // Coupa sets a line's Account in its "Account search" window (company code,
  // cost type, project, WBS element). Teach opens that window once and records
  // what you choose there, noting which choice was the company code, project
  // and WBS element. Every line after that, for any project, replays the same
  // choices with that project's values.

  var PROJECTS_KEY = 'coupaFiller.projects.v1';
  // { [project key]: { label, account, wbs, steps }, __template: { steps } }
  // step: { type: 'set', label, value, slot } | { type: 'click', text, slot }
  // slot: 'company' | 'project' | 'wbs' | '' (a fixed choice, like cost type)
  var recipes = storageGet(PROJECTS_KEY) || {};
  function saveRecipes() { storageSet(PROJECTS_KEY, recipes); }

  function currentAccount() {
    var form = lineForm();
    var el = form ? resolve(config.account.current, form) : null;
    return el ? (el.getAttribute('title') || el.textContent || '').trim() : '';
  }

  // The search window: the last visible dialog-like element with a field or
  // button in it (its fields may be plain boxes that open a search list).
  function accountModal() {
    var all = findAll(config.account.modal).filter(function (el) {
      return isVisible(el) && el.querySelector(FIELD + ', ' + CLICKABLE);
    });
    return all.length ? all[all.length - 1] : null;
  }

  async function openAccountModal() {
    realClick(await waitFor(config.account.open, 4000, lineForm));
    var modal = null;
    await waitUntil(function () { modal = accountModal(); return !!modal; }, 8000);
    if (!modal) throw new Error('the Account search window didn’t open.');
    await sleep(500);
  }

  function fieldName(el) {
    return labelFor(el) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '';
  }

  // A field in the search window, by the name recorded for it.
  function fieldNamed(name) {
    var modal = accountModal();
    if (!modal) return null;
    var byLabel = resolve('label:' + name, modal);
    if (byLabel) return byLabel;
    var wanted = norm(name);
    var fields = toArray(modal.querySelectorAll(FIELD)).filter(function (el) {
      return ['aria-label', 'placeholder', 'name'].some(function (a) { return norm(el.getAttribute(a)) === wanted; });
    });
    return fields.filter(isVisible).pop() || null;
  }

  // The type-ahead an option belongs to (it says so with aria-owns/controls).
  function comboboxOfOption(option) {
    for (var node = option; node && node !== document.body; node = node.parentElement) {
      if (!node.id) continue;
      var owner = document.querySelector('[aria-owns="' + cssEscape(node.id) + '"], [aria-controls="' + cssEscape(node.id) + '"]');
      if (owner) return owner;
    }
    return null;
  }

  var recording = null;

  // Watches you pick the cost code in the search window; resolves with the
  // steps once the window closes.
  function recordAccountSteps() {
    var steps = [];
    function record(step) {
      if (step.type === 'set') {
        for (var i = steps.length - 1; i >= 0; i--) {
          if (steps[i].type === 'set' && norm(steps[i].label) === norm(step.label)) steps.splice(i, 1);
        }
      }
      steps.push(step);
    }
    function inModal(el) {
      var modal = accountModal();
      return !!modal && modal.contains(el);
    }
    function onChange(e) {
      var el = e.target;
      if (!inModal(el) || el.type === 'hidden' || detectKind(el) === 'combobox') return;
      var name = fieldName(el);
      if (!name) return;
      var value = el.tagName === 'SELECT' && el.selectedOptions[0] ? el.selectedOptions[0].text : el.value;
      record({ type: 'set', label: name, value: String(value).trim() });
    }
    function onMouseDown(e) {
      if (e.target === host) return;
      var option = e.target.closest('[role="option"], li');
      var combo = option ? comboboxOfOption(option) : null;
      if (combo && inModal(combo)) {
        // Recorded right away: the window may close before Coupa updates the box.
        var name = fieldName(combo);
        var value = elementText(option).replace(/\s+/g, ' ').trim();
        if (name && value) record({ type: 'set', label: name, value: value });
        return;
      }
      var button = e.target.closest(CLICKABLE);
      if (button && inModal(button) && !button.closest('[role="combobox"]')) {
        var text = elementText(button).replace(/\s+/g, ' ').trim();
        if (text.length >= 2 && text.length <= 120) {
          record({ type: 'click', text: text, tag: button.tagName, selector: selectorFor(button, true) });
        }
      }
    }
    document.addEventListener('change', onChange, true);
    document.addEventListener('mousedown', onMouseDown, true);
    return new Promise(function (resolvePromise) {
      var timer = setInterval(function () {
        if (accountModal() && !recording.cancelled) return;
        clearInterval(timer);
        document.removeEventListener('change', onChange, true);
        document.removeEventListener('mousedown', onMouseDown, true);
        // Give Coupa a moment to update the line's Account.
        setTimeout(function () { resolvePromise(recording.cancelled ? null : steps); }, 700);
      }, 300);
      recording = { cancelled: false };
    });
  }

  // The cost code a line is charged to (lines from older app versions only
  // have the trip's).
  function codeFor(entry) {
    return (entry && entry.line.costCode) || (trip() && trip().project) || null;
  }

  function tripCodes() {
    if (!trip()) return [];
    var seen = {};
    var codes = [];
    lines().map(codeFor).concat([trip().project]).forEach(function (code) {
      if (code && !seen[code.key]) { seen[code.key] = true; codes.push(code); }
    });
    return codes;
  }

  // A project number is enough to search for; Teach covers the rest.
  function canSetAccount(code) {
    return !!(code.number || recipes[code.key] || recipes.__template);
  }

  // Which part of the cost code a recorded step chose, so the steps can be
  // replayed for any project.
  function slotFor(step, code) {
    var label = step.label || '';
    var value = norm(step.type === 'set' ? step.value : step.text);
    if (/wbs/i.test(label)) return 'wbs';
    if (/company/i.test(label)) return 'company';
    if (/project/i.test(label)) return 'project';
    if (code.number && value.indexOf(norm(code.number)) !== -1) return 'project';
    if (code.wbs && value.indexOf(norm(code.wbs)) !== -1) return 'wbs';
    if (code.company && value.indexOf(norm(code.company)) === 0) return 'company';
    // Without a known project, go by the shape of the codes.
    if (/\b\d{2}[a-z]\.\d{6}\b/.test(value)) return 'wbs';
    if (/\b\d{5}[a-z]\d\b/.test(value)) return 'project';
    if (/^\d{4}\b/.test(value) || /\(\d{4}\)/.test(value)) return 'company';
    return '';
  }

  function slotValue(step, code) {
    var recorded = step.type === 'set' ? step.value : step.text;
    if (step.slot === 'project') return code.number || code.label;
    if (step.slot === 'wbs') return code.wbs || recorded;
    if (step.slot === 'company') return code.company || recorded;
    return recorded;
  }

  // Projects picked in Coupa, waiting to be added to the expense site, as
  // cost code lines ("4010-Project WBS-12345B1-01A.021200 Name") that its
  // "Add projects from cost codes" box also accepts.
  var SEND_KEY = 'coupaFiller.toSend.v1';
  var toSend = storageGet(SEND_KEY) || [];
  function saveToSend() { storageSet(SEND_KEY, toSend); }

  // Set by the bookmarklet (built by the expense site) or the extension.
  function appUrl() {
    return window.__coupaFillerAppUrl || '';
  }

  // The cost code line for an account Coupa shows, named after the project
  // choice you clicked ("12345B1 - Main St Tower" -> "Main St Tower").
  function projectLine(account, steps) {
    var match = /(\d{3,5})\s*-\s*Project WBS\s*-\s*([A-Za-z0-9]+)-([A-Za-z0-9.]+)/.exec(account);
    if (!match) return '';
    var name = '';
    steps.forEach(function (step) {
      var value = step.type === 'set' ? step.value : step.text;
      if (step.slot === 'project' && norm(value).indexOf(norm(match[2])) === 0) {
        name = value.slice(match[2].length).replace(/^[\s\-–:]+/, '').trim();
      }
    });
    return match[1] + '-Project WBS-' + match[2] + '-' + match[3] + (name ? ' ' + name : '');
  }

  function queueProject(line) {
    var number = line.split('-')[2];
    toSend = toSend.filter(function (l) { return l.split('-')[2] !== number; });
    toSend.push(line);
    saveToSend();
  }

  // mode 'teach': learn how you pick a cost code (for every project).
  // mode 'add': pick a project's cost code to add it to the expense site
  //   (also teaches, if nothing was taught yet).
  async function captureProject(mode) {
    var entry = lines()[nextPendingIndex(0)] || lines()[0];
    // Without loaded expenses, any project will do: the recorded choices are
    // then sorted out by the Account search's field names alone.
    var code = (mode === 'teach' && codeFor(entry)) || { key: '', label: '', company: '', number: '', wbs: '' };
    if (running) return;
    running = true;
    say('Opening a line and Coupa’s Account search…');
    try {
      try {
        await openLineForm(false);
      } catch (e) {
        if (/Could not find/.test(e.message)) throw new Error('open a draft expense report in Coupa first (there’s no “Add Expense Line” button on this page).');
        throw e;
      }
      var before = currentAccount();
      await openAccountModal();
      ui.teaching = true;
      say(mode === 'add'
        ? 'Pick the project’s cost code in Coupa’s Account search as usual (company code, Project WBS, the project, the WBS element), then confirm it there.'
        : code.number
          ? 'Pick the cost code for ' + code.label + ' in Coupa’s Account search the way you usually do: company code ' +
            (code.company || '') + ', cost type Project WBS, project ' + code.number + ', WBS element ' + code.wbs +
            '. Then confirm it there. I’m watching, and will do the same for every project after this.'
          : 'Pick any project’s cost code in Coupa’s Account search the way you usually do: company code, cost type Project WBS, ' +
            'the project, the WBS element. Then confirm it there. I’m watching, and will do the same for every project after this.');
      var steps = await recordAccountSteps();
      if (!steps) { say('Cancelled.'); return; }
      var after = currentAccount();
      if (!steps.length || !after || after === before) {
        say('Nothing changed on the line’s Account, so nothing was saved. Try again, and finish with Coupa’s own confirm button.', true);
        return;
      }
      steps.forEach(function (step) { step.slot = slotFor(step, code); });
      // A click on something showing the current company (or project) that
      // opens a list to choose from is an opener: its text depends on the
      // line, so it is replayed by where it is, not what it says.
      steps.forEach(function (step, i) {
        var next = steps[i + 1];
        if (step.type === 'click' && step.slot && next && next.type === 'click' && next.slot === step.slot) step.slot = '';
      });
      if (mode === 'teach' || !recipes.__template) {
        if (code.key) recipes[code.key] = { label: code.label, account: after, wbs: code.wbs, steps: steps };
        recipes.__template = { steps: steps };
        saveRecipes();
      }
      // A project from the expense site's own data is already there.
      var line = projectLine(after, steps);
      if (line && !code.number) queueProject(line);
      if (mode === 'add') {
        say(line
          ? 'Got it: ' + line + '. Click “Add to expense site” below (or pick another project first). Cancel the empty line in Coupa when you’re done.'
          : 'Coupa shows “' + after + '”, which isn’t a project cost code, so it wasn’t added.', !line);
      } else {
        say('Learned it: ' + after + '. Lines for any project now get their cost code automatically. Click Fill next.' +
          (line && !code.number ? ' To add this project to the expense site too, use “Add to expense site” on the Cost codes tab.' : ''));
      }
    } catch (e) {
      say((mode === 'add' ? 'Add project: ' : 'Teach: ') + e.message, true);
    } finally {
      ui.teaching = false;
      recording = null;
      running = false;
      render();
    }
  }

  // A clickable choice in the search window: exact text first, then one
  // starting with or containing it (so "4010" finds "4010-Company (4010)"),
  // preferring the kind of element clicked while teaching.
  var CHOICE = CLICKABLE + ', [role="option"], [role="menuitem"], [role="row"], li, td';
  async function waitForChoice(value, tag, timeout) {
    var start = Date.now();
    while (Date.now() - start < timeout) {
      var modal = accountModal();
      if (modal) {
        var all = toArray(modal.querySelectorAll(CHOICE)).filter(isVisible);
        // Items of an open list or menu win over the button that opened it.
        var listItems = all.filter(function (el) { return el.matches('[role="option"], [role="menuitem"], li'); });
        var sameTag = tag ? all.filter(function (el) { return el.tagName === tag; }) : [];
        var match = bestOption(listItems, value) || bestOption(sameTag, value) || bestOption(all, value);
        if (match) return match.closest(CLICKABLE) || match;
      }
      await sleep(200);
    }
    return null;
  }

  // Leaves the search window without choosing, so the line can still be saved.
  async function closeAccountModal() {
    var modal = accountModal();
    if (!modal) return;
    var close = toArray(modal.querySelectorAll(CLICKABLE)).filter(isVisible).filter(function (el) {
      var label = norm(elementText(el) || el.getAttribute('aria-label') || el.getAttribute('title'));
      return /^(cancel|close|×|x)$/.test(label);
    })[0];
    if (close) {
      realClick(close);
    } else {
      key(document.activeElement || document.body, 'keydown', 'Escape');
      key(modal, 'keydown', 'Escape');
    }
    await waitUntil(function () { return !accountModal(); }, 3000);
  }

  // Sets the open line's Account to a project's cost code by replaying the
  // taught steps with that project's company code, number and WBS element.
  // The Account search window's fields, found by their labels, and the
  // project value to type into each one's search box.
  var ACCOUNT_FIELDS = [
    { label: /comp(any)?\s*code|compcode/i, name: 'Company Code', value: function (c) { return c.company; } },
    { label: /cost\s*type/i, name: 'Cost Type', value: function () { return 'Project WBS'; }, hint: function (c) { return c.company; } },
    { label: /proj/i, name: 'Project', value: function (c) { return c.number; } },
    { label: /wbs/i, name: 'WBS Element', value: function (c) { return c.wbs; } }
  ];
  var FIELD_WIDGET = '[role="combobox"], select, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), ' +
    '[class*="ComboBox__field"], [class*="select2-selection"], [class*="selection"], [class*="dropdown"]';
  var OPTION = '[role="option"], li, .select2-results__option, [class*="option"], [class*="result"]';

  // The row of the search window whose label matches.
  function accountRow(modal, labelRe) {
    var labels = toArray(modal.querySelectorAll('label, th, dt, [class*="label"]')).filter(function (el) {
      var text = (el.textContent || '').trim();
      return isVisible(el) && text.length < 80 && labelRe.test(text);
    });
    for (var i = 0; i < labels.length; i++) {
      var node = labels[i];
      if (node.htmlFor) {
        var target = document.getElementById(node.htmlFor);
        if (target) return { row: target.closest('tr, .form_element') || target.parentElement, widget: target };
      }
      for (var up = 0; up < 5 && node && node !== modal; up++) {
        node = node.parentElement;
        var widget = node && toArray(node.querySelectorAll(FIELD_WIDGET)).filter(function (el) {
          return !labels[i].contains(el) && isVisible(el);
        })[0];
        if (widget) return { row: node, widget: widget };
      }
      // No recognizable field: take what sits next to the label.
      var label = labels[i];
      var next = label.nextElementSibling;
      while (next && !isVisible(next)) next = next.nextElementSibling;
      if (next) return { row: label.parentElement, widget: next };
    }
    return null;
  }

  function visibleTextInputs() {
    return toArray(document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])')).filter(isVisible);
  }

  // Opens one field's dropdown, types the code into its search box and clicks
  // the result containing it (codes are unique, so there should be one).
  // hint: text that picks between several matches (the company code).
  async function pickInAccountField(field, value, hint) {
    var modal = accountModal();
    var found = modal && accountRow(modal, field.label);
    if (!found) throw new Error('no “' + field.name + '” field in the search window.');
    if (norm(found.row.textContent).indexOf(norm(value)) !== -1 && found.widget.tagName !== 'INPUT') return; // already chosen
    if (found.widget.tagName === 'SELECT') return setSelect(found.widget, value);

    var before = visibleTextInputs();
    // Only choices that appear once the list opens count, not text elsewhere
    // on the page (like saved lines showing their accounts).
    var onPage = toArray(document.querySelectorAll(OPTION)).filter(isVisible);
    realClick(found.widget);
    await sleep(400);
    var search = function () {
      var active = document.activeElement;
      if (active && active.tagName === 'INPUT' && isVisible(active)) return active;
      return visibleTextInputs().filter(function (el) { return before.indexOf(el) === -1; })[0] ||
        (found.widget.tagName === 'INPUT' ? found.widget : null);
    };
    var box = search();
    if (!box) {
      // Some dropdowns open from their arrow rather than the box.
      var toggle = found.row.querySelector('[class*="toggle"], [class*="arrow"], button');
      if (toggle) { realClick(toggle); await sleep(400); box = search(); }
    }
    if (!box) throw new Error('couldn’t open the “' + field.name + '” list.');
    typeInto(box, value);

    var wanted = norm(value);
    var choice = null;
    var start = Date.now();
    while (!choice && Date.now() - start < 6000) {
      await sleep(250);
      var options = toArray(document.querySelectorAll(OPTION)).filter(function (el) {
        return isVisible(el) && onPage.indexOf(el) === -1 && !found.widget.contains(el) && !el.querySelector(OPTION) &&
          norm(elementText(el)).indexOf(wanted) !== -1;
      });
      // Prefer "...(24037B1)" or "24037B1-..." over a mere mention.
      var exact = options.filter(function (el) {
        var t = norm(elementText(el));
        return t.indexOf('(' + wanted + ')') !== -1 || t.indexOf(wanted + '-') === 0 || t === wanted;
      });
      var hinted = hint ? options.filter(function (el) { return norm(elementText(el)).indexOf(norm(hint)) !== -1; }) : [];
      choice = exact[0] || (options.length === 1 ? options[0] : null) || (hinted.length === 1 ? hinted[0] : null);
    }
    if (!choice) {
      key(box, 'keydown', 'Escape');
      throw new Error('no “' + field.name + '” choice matching “' + value + '”.');
    }
    realClick(choice);
    await sleep(500);
  }

  // The search window's own confirm button: the one clicked while teaching,
  // or one with a confirm-like name.
  function confirmButton() {
    var modal = accountModal();
    if (!modal) return null;
    var taught = (recipes.__template ? recipes.__template.steps : []).filter(function (st) { return st.type === 'click' && !st.slot; }).pop();
    if (taught) {
      var el = taught.selector && taught.selector.indexOf('text:') !== 0 ? resolve(taught.selector, modal) : resolve('text:' + taught.text, modal);
      if (el) return el;
    }
    return toArray(modal.querySelectorAll(CLICKABLE)).filter(isVisible).filter(function (b) {
      return /^(save|ok|choose|select|apply|done|update|use (this )?account)$/.test(norm(elementText(b)));
    })[0] || null;
  }

  // Sets the line's Account by searching each field for the project's codes.
  async function searchCostCode(code) {
    await openAccountModal();
    for (var i = 0; i < ACCOUNT_FIELDS.length; i++) {
      var f = ACCOUNT_FIELDS[i];
      var value = f.value(code);
      if (value) await pickInAccountField(f, value, f.hint ? f.hint(code) : '');
    }
    var ok = confirmButton();
    if (ok) realClick(ok);
    if (!(await waitUntil(function () { return !accountModal(); }, ok ? 8000 : 2000))) {
      throw new Error(ok ? 'the search window didn’t close after confirming.' : 'couldn’t find the search window’s confirm button. Click Teach once so I learn it.');
    }
    await sleep(400);
    var now = currentAccount();
    if (code.number && norm(now).indexOf(norm(code.number)) === -1) {
      throw new Error('Coupa shows “' + now + '”, not ' + code.label + '.');
    }
  }

  // Search first; if that fails, replay what Teach recorded.
  async function applyCostCode(code) {
    var before = currentAccount();
    if (code.number && norm(before).indexOf(norm(code.number)) !== -1 && (!code.wbs || norm(before).indexOf(norm(code.wbs)) !== -1)) return;
    try {
      await searchCostCode(code);
    } catch (e) {
      await closeAccountModal();
      if (!(recipes[code.key] || recipes.__template)) throw new Error('Account: ' + e.message);
      try {
        await replayRecipe(code);
      } catch (replayError) {
        throw new Error('Account: ' + e.message);
      }
    }
  }

  async function replayRecipe(code) {
    var own = recipes[code.key];
    var recipe = own || recipes.__template;
    if (!recipe) throw new Error('Account: click Teach first, to show me how you pick a cost code.');
    var expected = own && norm(own.wbs) === norm(code.wbs) ? own.account : '';
    function isSet(account) {
      if (expected) return account === expected;
      return !!code.number && norm(account).indexOf(norm(code.number)) !== -1 &&
        norm(account).indexOf(norm(code.wbs)) !== -1;
    }
    var before = currentAccount();
    if (isSet(before)) return;

    try {
      await openAccountModal();
    } catch (e) {
      throw new Error('Account: ' + e.message);
    }
    for (var i = 0; i < recipe.steps.length; i++) {
      var step = recipe.steps[i];
      var value = slotValue(step, code);
      if (step.type === 'set') {
        var el = await waitFor('label:' + step.label, config.delays.fieldTimeout, accountModal).catch(function () { return fieldNamed(step.label); });
        if (!el) throw new Error('Account: no “' + step.label + '” field in the search window.');
        try {
          await setField(el, value, { kind: 'auto' });
        } catch (e) {
          throw new Error('Account, ' + step.label + ': ' + e.message);
        }
      } else {
        var button = null;
        if (!step.slot && step.selector && step.selector.indexOf('text:') !== 0) {
          button = await waitFor(step.selector, 3000, accountModal).catch(function () { return null; });
        }
        if (!button) button = await waitForChoice(value, step.tag, config.delays.fieldTimeout);
        if (!button) throw new Error('Account: couldn’t find “' + value + '” in the search window.');
        realClick(button);
      }
      await sleep(700);
    }
    var closed = await waitUntil(function () { return !accountModal(); }, 8000);
    if (!closed) throw new Error('Account: the search window is still open. Finish choosing the cost code there, then click Fill next.');
    await sleep(400);
    var now = currentAccount();
    // The WBS element may show as a name ("Travel") rather than in the code.
    var ok = expected ? now === expected
      : code.number ? norm(now).indexOf(norm(code.number)) !== -1
      : now !== before;
    if (!ok) {
      throw new Error('Account: Coupa shows “' + now + '”, not the cost code for ' + code.label + '. Fix it before saving.');
    }
  }

  // Opens a blank line form (reusing one that's already open and empty, or
  // the one a failed attempt at this same line left behind).
  async function openLineForm(retrying) {
    var form = config.lineForm ? resolve(config.lineForm) : null;
    if (form) {
      if (retrying || formIsBlank(form)) return;
      throw new Error('A line is open in Coupa with unsaved changes. Save or cancel it in Coupa, then click Fill next.');
    }
    if (!config.addLine) return;
    realClick(await waitFor(config.addLine, config.delays.fieldTimeout));
    if (config.lineForm) await waitFor(config.lineForm, config.delays.fieldTimeout);
    await sleep(config.delays.afterAddLine);
  }

  async function fillLine(entry) {
    var line = entry.line;
    var d = config.delays;
    await openLineForm(entry.status === 'error');

    var warnings = [];
    var fields = fieldsToFill();
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      var value = line[field.key];
      if (value === undefined || value === null || value === '') continue;
      var el;
      try {
        el = await waitFor(field.selector, d.fieldTimeout, lineForm);
      } catch (e) {
        throw new Error(field.label + ': field not found (' + field.selector + '). Check it in Setup → Advanced.');
      }
      try {
        await setField(el, String(value), field);
      } catch (e) {
        // A category or zip code Coupa doesn't list: fill the rest and leave it to you.
        if (field.key !== 'expenseType' && field.key !== 'zipCode') throw new Error(field.label + ': ' + e.message);
        warnings.push('Pick the ' + field.label + ' in Coupa: ' + e.message);
      }
      await sleep(field.waitAfter || d.betweenFields);
    }
    if (!line.expenseType) warnings.push('Pick the Expense Category in Coupa (the app has no Coupa category for “' + line.category + '”).');

    // A cost code that won't set never holds up the line: it is listed on
    // the Cost codes tab to set in Coupa instead.
    var code = codeFor(entry);
    entry.cost = '';
    entry.costError = '';
    if (code) {
      if (!config.setCostCodes || !canSetAccount(code)) {
        entry.cost = 'todo';
      } else {
        try {
          await applyCostCode(code);
          entry.cost = 'set';
        } catch (e) {
          entry.cost = 'todo';
          entry.costError = e.message.replace(/^Account:\s*/, '');
          await closeAccountModal();
        }
      }
    }

    if (warnings.length) return warnings.join(' ') + ' Then click Save in Coupa, and Fill next.';
    if (config.saveEachLine && config.save) {
      realClick(await waitFor(config.save, d.fieldTimeout, lineForm));
      var saved = await waitUntil(function () {
        var open = config.lineForm ? resolve(config.lineForm) : null;
        return !open || formIsBlank(open);
      }, d.afterSave + 6000);
      if (!saved) {
        return 'Coupa didn’t accept this line. Fix the highlighted field in Coupa and click Save there, then Fill next.';
      }
      await sleep(d.afterSave);
    }
    return '';
  }

  // ---------------------------------------------------------------------------
  // Filling loop
  // ---------------------------------------------------------------------------

  var running = false;
  var stopRequested = false;

  function nextPendingIndex(from) {
    var list = lines();
    for (var i = from; i < list.length; i++) {
      var s = list[i].status;
      if (s === 'pending' || s === 'error') return i;
    }
    return -1;
  }

  // Fills one line of the current trip. A line left "filled" (waiting for you
  // to click Save) counts as done once you move on.
  async function fillNext() {
    if (running || !trip()) return false;
    var list = lines();
    // Moving on means the lines waiting for you were saved in Coupa.
    list.forEach(function (l) { if (l.status === 'filled') { l.status = 'done'; l.error = ''; } });
    var index = nextPendingIndex(state.current);
    if (index === -1) index = nextPendingIndex(0);
    if (index === -1) {
      ui.message = tripDoneMessage();
      render();
      return false;
    }
    state.current = index;
    running = true;
    ui.message = '';
    render();
    var entry = list[index];
    try {
      var warning = await fillLine(entry);
      entry.status = config.saveEachLine && !warning ? 'done' : 'filled';
      entry.error = warning;
      if (!warning) state.current = index + 1;
      return !warning;
    } catch (e) {
      entry.status = 'error';
      entry.error = e.message;
      return false;
    } finally {
      running = false;
      saveState();
      render();
    }
  }

  async function fillAll() {
    stopRequested = false;
    while (!stopRequested) {
      var ok = await fillNext();
      if (!ok) break;
    }
    stopRequested = false;
    if (nextPendingIndex(0) === -1) ui.message = tripDoneMessage();
    render();
  }

  function tripDoneMessage() {
    var next = state.trips.findIndex(function (t, i) {
      return i !== state.trip && t.lines.some(function (l) { return l.status === 'pending' || l.status === 'error'; });
    });
    return 'All lines for this trip are entered. Check the report in Coupa and submit it.' +
      (next !== -1 ? ' Then pick the next trip above and create its report.' : '');
  }

  async function newReportForTrip() {
    if (running) return;
    running = true;
    ui.message = 'Creating a new Coupa report…';
    ui.messageErr = false;
    render();
    try {
      var result = await createReport(trip().title);
      trip().report = result.number;
      ui.message = result.warning || ('Created report ' + result.number + '. Click Fill next' + (config.saveEachLine ? ' or Fill all.' : '.'));
      ui.messageErr = !!result.warning;
    } catch (e) {
      ui.message = e.message;
      ui.messageErr = true;
    } finally {
      running = false;
      saveState();
      render();
    }
  }

  // ---------------------------------------------------------------------------
  // Element picker (Setup tab)
  // ---------------------------------------------------------------------------

  function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
  }

  function isUnique(selector, el) {
    try {
      var all = document.querySelectorAll(selector);
      return all.length === 1 && all[0] === el;
    } catch (e) {
      return false;
    }
  }

  // id/name values like "merchant_239" change per line, so turn them into
  // prefix/suffix matches that work for every line.
  function attrSelector(tag, attr, value) {
    if (!/\d{2,}/.test(value)) return tag + '[' + attr + '="' + value.replace(/"/g, '\\"') + '"]';
    var parts = value.split(/\d{2,}/);
    var prefix = parts[0];
    var suffix = parts[parts.length - 1];
    var sel = tag;
    if (prefix.length >= 3) sel += '[' + attr + '^="' + prefix.replace(/"/g, '\\"') + '"]';
    if (suffix.length >= 3) sel += '[' + attr + '$="' + suffix.replace(/"/g, '\\"') + '"]';
    return sel === tag ? null : sel;
  }

  function labelFor(el) {
    var label = el.id ? document.querySelector('label[for="' + cssEscape(el.id) + '"]') : null;
    if (!label) label = el.closest('label');
    var text = label ? norm(label.textContent) : '';
    return text && text.length < 40 ? label.textContent.replace(/\s+/g, ' ').replace(/\*/g, '').trim() : '';
  }

  function selectorFor(el, isButton) {
    var tag = el.tagName.toLowerCase();
    // Coupa marks its controls with stable "s-..." classes.
    var hook = toArray(el.classList).filter(function (c) { return /^s-[A-Za-z]/.test(c) && !/\d{2,}/.test(c); })[0];
    if (hook) return tag + '.' + cssEscape(hook);
    if (el.id && !/\d{2,}/.test(el.id) && isUnique('#' + cssEscape(el.id), el)) return '#' + cssEscape(el.id);
    var attrs = ['name', 'data-testid', 'data-test', 'data-qa', 'data-field', 'aria-label', 'placeholder', 'id'];
    for (var i = 0; i < attrs.length; i++) {
      var value = el.getAttribute(attrs[i]);
      if (!value) continue;
      var sel = attrSelector(tag, attrs[i], value);
      if (sel && findAll(sel).length >= 1) return sel;
    }
    if (isButton) {
      var text = elementText(el).replace(/\s+/g, ' ').trim();
      if (text && text.length < 40) return 'text:' + text;
    } else {
      var label = labelFor(el);
      if (label) return 'label:' + label;
    }
    // Last resort: a structural path (fragile; prefer editing by hand).
    var path = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.body && path.length < 6) {
      var part = node.tagName.toLowerCase();
      if (node.id && !/\d{2,}/.test(node.id)) { path.unshift('#' + cssEscape(node.id)); break; }
      var siblings = node.parentElement ? Array.prototype.filter.call(node.parentElement.children, function (c) { return c.tagName === node.tagName; }) : [];
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      path.unshift(part);
      node = node.parentElement;
    }
    return path.join(' > ');
  }

  var picker = null;

  function startPicker(isButton, onPick) {
    stopPicker();
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #4f46e5;background:rgba(79,70,229,.12);border-radius:4px;transition:all .05s';
    document.documentElement.appendChild(box);

    function targetOf(e) {
      var el = e.target;
      if (el === host) return null;
      if (isButton) return el.closest(CLICKABLE) || el;
      return el.closest(FIELD) || el;
    }
    function onMove(e) {
      var el = targetOf(e);
      if (!el) { box.style.display = 'none'; return; }
      var r = el.getBoundingClientRect();
      box.style.display = 'block';
      box.style.left = r.left - 2 + 'px';
      box.style.top = r.top - 2 + 'px';
      box.style.width = r.width + 4 + 'px';
      box.style.height = r.height + 4 + 'px';
    }
    function swallow(e) {
      if (e.target === host) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    function onClick(e) {
      var el = targetOf(e);
      if (!el) return;
      swallow(e);
      stopPicker();
      onPick(selectorFor(el, isButton));
    }
    function onKey(e) {
      if (e.key === 'Escape') { stopPicker(); ui.picking = ''; render(); }
    }
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mousedown', swallow, true);
    document.addEventListener('mouseup', swallow, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    picker = function () {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mousedown', swallow, true);
      document.removeEventListener('mouseup', swallow, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      box.remove();
    };
  }

  function stopPicker() {
    if (picker) { picker(); picker = null; }
  }

  // ---------------------------------------------------------------------------
  // Panel UI (in a shadow root so Coupa's styles don't leak in)
  // ---------------------------------------------------------------------------

  var host = document.createElement('div');
  host.id = 'coupa-filler-host';
  host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;';
  var root = host.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(host);

  var ui = { tab: state.trips.length ? 'run' : 'load', minimized: false, message: '', messageErr: false, picking: '', teaching: false, advanced: false };

  var STYLE = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
    '.panel{width:380px;max-height:calc(100vh - 32px);display:flex;flex-direction:column;background:#fff;color:#1e293b;border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 12px 40px rgba(15,23,42,.25);font-size:13px;overflow:hidden}',
    '.head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#4f46e5;color:#fff;cursor:default}',
    '.head b{flex:1;font-size:14px}',
    '.head button{background:rgba(255,255,255,.15);color:#fff;border:0;border-radius:6px;width:26px;height:26px;cursor:pointer;font-size:14px}',
    '.tabs{display:flex;border-bottom:1px solid #e2e8f0}',
    '.tabs button{flex:1;padding:8px;border:0;background:none;cursor:pointer;color:#64748b;font-weight:600;font-size:12px;border-bottom:2px solid transparent}',
    '.tabs button.on{color:#4f46e5;border-bottom-color:#4f46e5}',
    '.body{padding:12px;overflow:auto;display:flex;flex-direction:column;gap:10px}',
    'textarea,input[type=text],input[type=number],select{width:100%;padding:7px 8px;border:1px solid #cbd5e1;border-radius:8px;font-size:12px;color:#1e293b;background:#fff}',
    'textarea{min-height:90px;font-family:ui-monospace,Menlo,monospace}',
    '.btn{padding:8px 12px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;color:#1e293b;font-weight:600;cursor:pointer;font-size:12px}',
    '.btn.primary{background:#4f46e5;border-color:#4f46e5;color:#fff}',
    '.btn:disabled{opacity:.5;cursor:not-allowed}',
    '.row{display:flex;gap:8px;align-items:center}',
    '.row > .grow{flex:1;min-width:0}',
    '.muted{color:#64748b;font-size:12px;line-height:1.4}',
    '.msg{padding:8px 10px;border-radius:8px;background:#eef2ff;color:#3730a3;font-size:12px;line-height:1.4}',
    '.msg.err{background:#fef2f2;color:#991b1b}',
    '.trip{border:1px solid #e2e8f0;border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px;background:#f8fafc}',
    '.lines{display:flex;flex-direction:column;gap:4px;max-height:280px;overflow:auto}',
    '.line{display:grid;grid-template-columns:18px 1fr auto;gap:8px;align-items:start;padding:6px 8px;border-radius:8px;border:1px solid #f1f5f9;cursor:pointer}',
    '.line.cur{border-color:#a5b4fc;background:#eef2ff}',
    '.line .t{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.line .s{color:#64748b;font-size:11px}',
    '.line .e{color:#b91c1c;font-size:11px;grid-column:2 / 4;line-height:1.35}',
    '.amt{font-variant-numeric:tabular-nums;font-weight:600}',
    '.field{border:1px solid #e2e8f0;border-radius:10px;padding:8px;display:flex;flex-direction:column;gap:6px}',
    '.field .top{display:flex;align-items:center;gap:6px;font-weight:600}',
    '.ok{color:#059669;font-size:11px}.bad{color:#b91c1c;font-size:11px}',
    'label.chk{display:flex;gap:6px;align-items:center;font-size:12px}',
    'h4{margin:4px 0 0;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#64748b}'
  ].join('');

  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var STATUS_ICON = { pending: '○', filled: '✎', done: '✓', skipped: '–', error: '!' };
  var STATUS_COLOR = { pending: '#94a3b8', filled: '#d97706', done: '#059669', skipped: '#94a3b8', error: '#dc2626' };

  function countDone(list) {
    return list.filter(function (l) { return l.status === 'done' || l.status === 'skipped'; }).length;
  }

  function renderLoad() {
    return '' +
      '<div class="muted">In Travel Expense Reporter, click <b>Copy for bookmarklet</b>, then paste here (Ctrl+V / ⌘V).</div>' +
      '<textarea id="paste" placeholder="Paste here"></textarea>' +
      '<div class="row"><button class="btn primary" data-act="load">Load expenses</button>' +
      '<button class="btn" data-act="clipboard">Read clipboard</button></div>';
  }

  function renderRun() {
    if (!state.trips.length) return '<div class="muted">No expenses loaded yet.</div>' + renderLoad();
    var t = trip();
    var list = lines();
    var html = '<div class="trip">';
    if (state.trips.length > 1) {
      html += '<select data-trip>' + state.trips.map(function (tr, i) {
        return '<option value="' + i + '"' + (i === state.trip ? ' selected' : '') + '>' +
          esc((tr.title || 'Trip ' + (i + 1)) + ' — ' + countDone(tr.lines) + '/' + tr.lines.length) + '</option>';
      }).join('') + '</select>';
    } else {
      html += '<b>' + esc(t.title || 'Trip') + '</b>';
    }
    html += '<div class="row"><span class="grow muted">' +
      (t.report ? 'Coupa report <b>' + esc(t.report) + '</b>' : 'Not linked to a Coupa report yet') + '</span>' +
      '<span class="muted"><b>' + countDone(list) + ' / ' + list.length + '</b></span></div>';
    if (!t.report) {
      html += '<div class="row"><button class="btn primary grow" data-act="newReport"' + (running ? ' disabled' : '') + '>New Coupa report for this trip</button>' +
        '<button class="btn" data-act="useOpen"' + (running ? ' disabled' : '') + ' title="Add lines to the report that is open in Coupa">Use open report</button></div>';
    }
    var codes = tripCodes();
    if (codes.length) {
      var todo = list.filter(function (l) { return l.cost === 'todo'; }).length;
      var set = list.filter(function (l) { return l.cost === 'set'; }).length;
      html += '<div class="row"><span class="grow muted">Cost codes: ' + set + ' set' + (todo ? ', <b class="bad">' + todo + ' to do in Coupa</b>' : '') +
        '</span><button class="btn" data-tab="codes">Cost codes</button></div>';
    }
    html += '</div>';

    var waiting = list.some(function (l) { return l.status === 'filled' && !l.error; });
    if (waiting && !config.saveEachLine) {
      html += '<div class="msg">Check the line in Coupa, click <b>Save</b> there, then <b>Fill next</b>.</div>';
    }
    html += '<div class="lines">';
    list.forEach(function (l, i) {
      var line = l.line;
      html += '<div class="line' + (i === state.current ? ' cur' : '') + '" data-line="' + i + '">' +
        '<span style="color:' + STATUS_COLOR[l.status] + ';font-weight:700">' + STATUS_ICON[l.status] + '</span>' +
        '<div style="min-width:0"><div class="t">' + esc(line.merchant) + '</div>' +
        '<div class="s">' + esc(line.date) + ' · ' + esc(line.expenseType) + '</div></div>' +
        '<span class="amt">' + esc(line.amount) + '</span>' +
        (l.error ? '<div class="e">' + esc(l.error) + '</div>' : '') +
        '</div>';
    });
    html += '</div>';
    var canFill = !running && !!t.report;
    html += '<div class="row">' +
      '<button class="btn primary grow" data-act="next"' + (canFill ? '' : ' disabled') + '>' + (running ? 'Working…' : 'Fill next') + '</button>' +
      (running
        ? '<button class="btn" data-act="stop">Stop</button>'
        : '<button class="btn" data-act="all"' + (canFill && config.saveEachLine ? '' : ' disabled') +
          (config.saveEachLine ? '' : ' title="Turn on “Save each line” in Setup"') + '>Fill all</button>') +
      '<button class="btn" data-act="skip"' + (running || !list[state.current] ? ' disabled' : '') + '>Skip</button></div>';
    if (!config.saveEachLine) {
      html += '<div class="muted">You click Save in Coupa for each line. Turn on “Save each line” in Setup to enable Fill all.</div>';
    }
    return html;
  }

  function fieldStatus(selector, scope) {
    if (!selector) return '<span class="muted">not set</span>';
    try {
      return resolve(selector, scope) ? '<span class="ok">found on this page</span>' : '<span class="bad">not on screen right now</span>';
    } catch (e) {
      return '<span class="bad">' + esc(e.message) + '</span>';
    }
  }

  function renderCodes() {
    var html = '<label class="chk"><input type="checkbox" data-setcost' + (config.setCostCodes ? ' checked' : '') +
      '>Set cost codes while filling lines</label>' +
      '<div class="muted">Lines are always filled and saved. Any cost code that couldn’t be set is listed below to set in Coupa.</div>';

    // What the filler knows about picking cost codes.
    html += '<h4>How cost codes are picked</h4><div class="field">' +
      '<div class="muted">The filler searches each Account field for the project’s codes (company, Project WBS, project number, WBS element). Teach is only needed if that doesn’t work.</div>';
    if (ui.teaching) {
      html += '<div class="row"><span class="grow muted">Watching the Account search window… Pick the cost code there and confirm it.</span><button class="btn" data-act="cancelTeach">Cancel</button></div>';
    } else if (recipes.__template) {
      html += '<div class="row"><span class="grow ok">✓ Taught too</span>' +
        '<button class="btn" data-act="teach"' + (running ? ' disabled' : '') + ' title="Show me again how you pick a cost code">Re-teach</button></div>';
    } else {
      html += '<div class="row"><span class="grow muted">Teach (optional): show me once how you pick a cost code.</span><button class="btn" data-act="teach"' + (running ? ' disabled' : '') + '>Teach</button></div>';
    }
    if (!ui.teaching) {
      html += '<div class="row"><span class="grow muted">New project? Pick it here and send it to the expense site.</span>' +
        '<button class="btn" data-act="addProject"' + (running ? ' disabled' : '') + '>Add a project</button></div>';
    }
    if (toSend.length) {
      var url = appUrl();
      html += '<div class="msg">' + toSend.length + (toSend.length === 1 ? ' project' : ' projects') + ' to add to the expense site:<br><b>' +
        toSend.map(esc).join('<br>') + '</b></div><div class="row">' +
        (url ? '<a class="btn primary grow" style="text-align:center;text-decoration:none" data-act="sendProjects" target="_blank" rel="noopener" href="' +
          esc(url + '#coupa-projects=' + encodeURIComponent(toSend.join('\n'))) + '">Add to expense site ↗</a>' : '') +
        '<button class="btn' + (url ? '' : ' primary grow') + '" data-act="copyProjects">Copy</button></div>';
    }
    html += '</div>';

    // This trip's lines, by project.
    if (!trip()) return html + '<div class="muted">Paste your expenses to see each line’s cost code here.</div>';
    var groups = {};
    var order = [];
    lines().forEach(function (l) {
      var code = codeFor(l);
      if (!code) return;
      if (!groups[code.key]) { groups[code.key] = { code: code, lines: [] }; order.push(code.key); }
      groups[code.key].lines.push(l);
    });
    if (!order.length) return html + '<div class="muted">No project on this trip: its lines keep your default cost center.</div>';
    html += '<h4>This trip’s lines</h4>';
    order.forEach(function (k) {
      var g = groups[k];
      var c = g.code;
      html += '<div class="field"><div class="row"><div class="grow"><b>' + esc(c.label) + '</b><div class="muted">' +
        esc([c.company, 'Project WBS', c.number, c.wbs].filter(Boolean).join(' · ')) + '</div></div>' +
        '<button class="btn" data-copy="' + esc(c.number || c.label) + '" title="Copy the project number">Copy #</button></div>';
      g.lines.forEach(function (l) {
        var icon = l.cost === 'set' ? '<span class="ok">✓</span>' : l.cost === 'todo' ? '<span class="bad">✎</span>' : '<span class="muted">○</span>';
        html += '<div class="row" style="font-size:12px"><span style="width:14px">' + icon + '</span><span class="grow">' + esc(l.line.merchant) +
          ' <span class="muted">' + esc(l.line.date) + '</span>' +
          (l.costError ? '<div class="bad">' + esc(l.costError) + '</div>' : '') + '</span><span class="amt">' + esc(l.line.amount) + '</span></div>';
      });
      html += '</div>';
    });
    html += '<div class="muted"><span class="ok">✓</span> set · <span class="bad">✎</span> set it in Coupa · ○ not filled yet. ' +
      'To set several lines at once in Coupa: tick them, then <b>Bulk Line Actions → Edit</b> and pick the Account.</div>';
    return html;
  }

  function renderSetup() {
    var html = '';
    html += '<h4>Options</h4>' +
      '<label class="chk"><input type="checkbox" data-autosave' + (config.saveEachLine ? ' checked' : '') + '>Save each line: click Coupa’s Save after filling it (needed for Fill all)</label>';
    html += '<h4>Back up</h4>' +
      '<div class="muted">Saved in this browser only. Copy it to keep a backup or move it to another computer.</div>' +
      '<div class="row"><button class="btn" data-act="export">Copy setup</button><button class="btn" data-act="import">Import setup…</button></div>';
    html += '<button class="btn" data-act="advanced" style="border:0;padding-left:0;color:#64748b;text-align:left">' +
      (ui.advanced ? '▾' : '▸') + ' Advanced: only if Coupa’s screen changes</button>';
    if (ui.advanced) html += renderAdvanced();
    return html;
  }

  // Where the filler clicks and types. Preset for Coupa's expense screen.
  function renderAdvanced() {
    var html = '<div class="muted">Change these only if a button or field isn’t found: open a line in Coupa, click <b>Pick</b>, then click the matching button or field. Esc cancels.</div>';
    html += '<h4>Buttons</h4>';
    BUTTONS.forEach(function (b) {
      html += '<div class="field"><div class="top"><span style="flex:1">' + b[1] + '</span>' +
        '<button class="btn" data-pick="' + b[0] + '">' + (ui.picking === b[0] ? 'Click it…' : 'Pick') + '</button></div>' +
        '<input type="text" data-cfg="' + b[0] + '" value="' + esc(config[b[0]]) + '">' + fieldStatus(config[b[0]]) + '</div>';
    });
    var form = lineForm();
    html += '<h4>Line fields (in fill order)</h4>';
    config.fields.forEach(function (f, i) {
      html += '<div class="field"><div class="top">' +
        '<label class="chk" style="flex:1"><input type="checkbox" data-fen="' + i + '"' + (f.enabled ? ' checked' : '') + '>' + esc(f.label) + '</label>' +
        '<button class="btn" data-up="' + i + '" title="Move up"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button class="btn" data-pick="f' + i + '">' + (ui.picking === 'f' + i ? 'Click it…' : 'Pick') + '</button></div>' +
        '<div class="row"><input class="grow" type="text" data-fsel="' + i + '" value="' + esc(f.selector) + '">' +
        '<select data-fkind="' + i + '" style="width:110px">' +
        ['auto', 'text', 'select', 'combobox'].map(function (k) { return '<option' + (f.kind === k ? ' selected' : '') + '>' + k + '</option>'; }).join('') +
        '</select></div>' + (f.enabled && form ? fieldStatus(f.selector, form) : '') + '</div>';
    });
    html += '<h4>Timing</h4>' +
      '<div class="row"><span class="grow muted">Wait after “Add Expense Line” (ms)</span><input type="number" style="width:90px" data-delay="afterAddLine" value="' + config.delays.afterAddLine + '"></div>' +
      '<div class="row"><span class="grow muted">Wait after Save (ms)</span><input type="number" style="width:90px" data-delay="afterSave" value="' + config.delays.afterSave + '"></div>' +
      '<div class="row"><button class="btn" data-act="reset">Reset to Coupa defaults</button></div>';
    return html;
  }

  function render() {
    var list = lines();
    var html = '<style>' + STYLE + '</style><div class="panel">' +
      '<div class="head"><b>Coupa Filler' + (list.length ? ' · ' + countDone(list) + '/' + list.length : '') + '</b>' +
      '<button data-act="min" title="Minimize">' + (ui.minimized ? '▢' : '–') + '</button>' +
      '<button data-act="close" title="Close">×</button></div>';
    if (!ui.minimized) {
      html += '<div class="tabs">' +
        ['load', 'run', 'codes', 'setup'].map(function (t) {
          return '<button data-tab="' + t + '" class="' + (ui.tab === t ? 'on' : '') + '">' + { load: 'Paste data', run: 'Enter lines', codes: 'Cost codes', setup: 'Setup' }[t] + '</button>';
        }).join('') + '</div><div class="body">';
      if (ui.message) html += '<div class="msg' + (ui.messageErr ? ' err' : '') + '">' + esc(ui.message) + '</div>';
      html += ui.tab === 'load' ? renderLoad() : ui.tab === 'run' ? renderRun() : ui.tab === 'codes' ? renderCodes() : renderSetup();
      html += '<div class="muted" style="text-align:right">v' + VERSION + '</div></div>';
    }
    html += '</div>';
    var scroll = root.querySelector('.body');
    var top = scroll ? scroll.scrollTop : 0;
    root.innerHTML = html;
    var body = root.querySelector('.body');
    if (body) body.scrollTop = top;
  }

  function say(message, isError) {
    ui.message = message;
    ui.messageErr = !!isError;
    render();
  }

  function acceptPayload(input) {
    try {
      var trips = parsePayload(input).filter(function (t) { return t.lines && t.lines.length; });
      if (!trips.length) throw new Error('The copied data has no expense lines.');
      loadTrips(trips);
      ui.tab = 'run';
      var count = trips.reduce(function (n, t) { return n + t.lines.length; }, 0);
      say('Loaded ' + trips.length + (trips.length === 1 ? ' trip' : ' trips') + ' (' + count + ' lines). ' +
        'Click “New Coupa report for this trip”, or open a report in Coupa and click “Use open report”.');
    } catch (e) {
      say(e.message, true);
    }
  }

  root.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act],[data-tab],[data-line],[data-pick],[data-up],[data-copy]');
    if (!t) return;
    if (t.hasAttribute('data-copy')) {
      var text = t.getAttribute('data-copy');
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { say('Copied ' + text + '.'); });
      else window.prompt('Copy:', text);
      return;
    }
    var act = t.getAttribute('data-act');
    if (t.hasAttribute('data-tab')) { ui.tab = t.getAttribute('data-tab'); ui.message = ''; render(); return; }
    if (t.hasAttribute('data-line')) {
      if (running) return;
      state.current = Number(t.getAttribute('data-line'));
      var l = lines()[state.current];
      if (l.status === 'done' || l.status === 'skipped') { l.status = 'pending'; l.error = ''; }
      saveState(); render(); return;
    }
    if (t.hasAttribute('data-up')) {
      var i = Number(t.getAttribute('data-up'));
      var moved = config.fields.splice(i, 1)[0];
      config.fields.splice(i - 1, 0, moved);
      saveConfig(); render(); return;
    }
    if (t.hasAttribute('data-pick')) {
      var target = t.getAttribute('data-pick');
      if (ui.picking === target) { stopPicker(); ui.picking = ''; render(); return; }
      ui.picking = target;
      render();
      startPicker(target.charAt(0) !== 'f', function (selector) {
        if (target.charAt(0) === 'f') {
          var f = config.fields[Number(target.slice(1))];
          f.selector = selector;
          f.enabled = true;
        } else {
          config[target] = selector;
        }
        ui.picking = '';
        saveConfig();
        render();
      });
      return;
    }
    switch (act) {
      case 'min': ui.minimized = !ui.minimized; render(); break;
      case 'close': api.destroy(); break;
      case 'load': acceptPayload(root.getElementById('paste').value); break;
      case 'clipboard':
        if (!navigator.clipboard || !navigator.clipboard.readText) { say('This page cannot read the clipboard. Paste into the box instead.', true); break; }
        navigator.clipboard.readText().then(acceptPayload, function () {
          say('Clipboard access was blocked. Paste into the box instead (Ctrl+V / ⌘V).', true);
        });
        break;
      case 'newReport': newReportForTrip(); break;
      case 'teach': captureProject('teach'); break;
      case 'addProject': captureProject('add'); break;
      case 'sendProjects':
        // The link opens the expense site; clear the list once it has gone.
        setTimeout(function () {
          toSend = [];
          saveToSend();
          say('Sent. The expense site opened in a new tab with the projects added.');
        }, 0);
        break;
      case 'copyProjects': {
        var codes = toSend.join('\n');
        var copied = function () {
          toSend = [];
          saveToSend();
          say('Copied. On the expense site: sliders icon in “4. Enter into Coupa” → “Add projects from cost codes” → paste.');
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(codes).then(copied, function () { window.prompt('Copy these cost codes:', codes); copied(); });
        } else {
          window.prompt('Copy these cost codes:', codes);
          copied();
        }
        break;
      }
      case 'advanced': ui.advanced = !ui.advanced; render(); break;
      case 'cancelTeach': if (recording) recording.cancelled = true; break;
      case 'useOpen':
        trip().report = reportNumber() || 'open report';
        saveState();
        say('Adding lines to ' + trip().report + '. Click Fill next.');
        break;
      case 'next': fillNext(); break;
      case 'all': fillAll(); break;
      case 'stop': stopRequested = true; say('Stopping after this line…'); break;
      case 'skip': {
        var list = lines();
        list[state.current].status = 'skipped';
        var n = nextPendingIndex(state.current);
        state.current = n === -1 ? state.current : n;
        saveState(); render(); break;
      }
      case 'reload': ui.tab = 'load'; ui.message = ''; render(); break;
      case 'export': {
        var text = JSON.stringify(Object.assign({}, config, { projects: recipes }), null, 2);
        var done = function () { say('Setup copied. Paste it into Import on another computer.'); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () { window.prompt('Copy this setup:', text); });
        } else {
          window.prompt('Copy this setup:', text);
        }
        break;
      }
      case 'import': {
        var raw = window.prompt('Paste a setup copied from “Copy setup”:');
        if (!raw) break;
        try {
          var imported = JSON.parse(raw);
          config = mergeConfig(imported);
          saveConfig();
          if (imported.projects) {
            recipes = Object.assign(recipes, imported.projects);
            saveRecipes();
          }
          say('Setup imported.');
        } catch (err) {
          say('That setup could not be read: ' + err.message, true);
        }
        break;
      }
      case 'reset':
        if (window.confirm('Reset where the filler clicks and types to Coupa’s defaults? What it learned from Teach is kept.')) {
          config = clone(DEFAULT_CONFIG);
          saveConfig();
          say('Setup reset.');
        }
        break;
    }
  });

  root.addEventListener('change', function (e) {
    var t = e.target;
    if (t.hasAttribute('data-trip')) {
      state.trip = Number(t.value);
      var n = nextPendingIndex(0);
      state.current = n === -1 ? 0 : n;
      ui.message = '';
      saveState();
      render();
      return;
    }
    if (t.hasAttribute('data-cfg')) config[t.getAttribute('data-cfg')] = t.value.trim();
    else if (t.hasAttribute('data-fsel')) config.fields[Number(t.getAttribute('data-fsel'))].selector = t.value.trim();
    else if (t.hasAttribute('data-fkind')) config.fields[Number(t.getAttribute('data-fkind'))].kind = t.value;
    else if (t.hasAttribute('data-fen')) config.fields[Number(t.getAttribute('data-fen'))].enabled = t.checked;
    else if (t.hasAttribute('data-autosave')) config.saveEachLine = t.checked;
    else if (t.hasAttribute('data-setcost')) config.setCostCodes = t.checked;
    else if (t.hasAttribute('data-delay')) config.delays[t.getAttribute('data-delay')] = Math.max(0, Number(t.value) || 0);
    else return;
    saveConfig();
    render();
  });

  // Keep Coupa's keyboard shortcuts from firing while typing in the panel.
  ['keydown', 'keyup', 'keypress'].forEach(function (type) {
    host.addEventListener(type, function (e) { e.stopPropagation(); });
  });

  var api = {
    version: VERSION,
    // payload: optional object/JSON string from the app (the extension passes it).
    open: function (payload) {
      host.style.display = '';
      ui.minimized = false;
      if (payload) acceptPayload(payload);
      else render();
    },
    destroy: function () {
      stopRequested = true;
      stopPicker();
      host.remove();
      delete window.__coupaFiller;
    }
  };
  window.__coupaFiller = api;
  render();
})();
