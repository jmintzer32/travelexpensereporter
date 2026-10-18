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

  var VERSION = '2.0.0';
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
    autoSave: false,
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

  // state.trips: [{ title, startDate, endDate, report, lines: [{ line, status, error }] }]
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

    var fields = fieldsToFill();
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      var value = line[field.key];
      if (value === undefined || value === null || value === '') continue;
      var el;
      try {
        el = await waitFor(field.selector, d.fieldTimeout, lineForm);
      } catch (e) {
        throw new Error(field.label + ': field not found (' + field.selector + '). Check it in Setup.');
      }
      try {
        await setField(el, String(value), field);
      } catch (e) {
        throw new Error(field.label + ': ' + e.message);
      }
      await sleep(field.waitAfter || d.betweenFields);
    }

    if (config.autoSave && config.save) {
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
    list.forEach(function (l) { if (l.status === 'filled' && !l.error) l.status = 'done'; });
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
      entry.status = config.autoSave && !warning ? 'done' : 'filled';
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
      ui.message = result.warning || ('Created report ' + result.number + '. Click Fill next' + (config.autoSave ? ' or Fill all.' : '.'));
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

  var ui = { tab: state.trips.length ? 'run' : 'load', minimized: false, message: '', messageErr: false, picking: '' };

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
    html += '</div>';

    var waiting = list.some(function (l) { return l.status === 'filled' && !l.error; });
    if (waiting && !config.autoSave) {
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
      (config.autoSave
        ? (running ? '<button class="btn" data-act="stop">Stop</button>' : '<button class="btn" data-act="all"' + (canFill ? '' : ' disabled') + '>Fill all</button>')
        : '') +
      '<button class="btn" data-act="skip"' + (running || !list[state.current] ? ' disabled' : '') + '>Skip</button></div>';
    if (!config.autoSave) {
      html += '<div class="muted">You click Save in Coupa for each line. Turn on auto-save in Setup to enable “Fill all”.</div>';
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

  function renderSetup() {
    var html = '<div class="muted">Already set up for Coupa’s standard expense screen. Only change these if something isn’t found: open a line form in Coupa, click <b>Pick</b>, then click the matching button or field. Esc cancels.</div>';
    html += '<h4>Options</h4>' +
      '<label class="chk"><input type="checkbox" data-autosave' + (config.autoSave ? ' checked' : '') + '>Click Coupa’s Save after filling each line (enables Fill all)</label>';
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
      '<h4>Share setup</h4>' +
      '<div class="row"><button class="btn" data-act="export">Copy setup</button><button class="btn" data-act="import">Import setup…</button><button class="btn" data-act="reset">Reset</button></div>';
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
        ['load', 'run', 'setup'].map(function (t) {
          return '<button data-tab="' + t + '" class="' + (ui.tab === t ? 'on' : '') + '">' + { load: 'Paste data', run: 'Enter lines', setup: 'Setup' }[t] + '</button>';
        }).join('') + '</div><div class="body">';
      if (ui.message) html += '<div class="msg' + (ui.messageErr ? ' err' : '') + '">' + esc(ui.message) + '</div>';
      html += ui.tab === 'load' ? renderLoad() : ui.tab === 'run' ? renderRun() : renderSetup();
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
    var t = e.target.closest('[data-act],[data-tab],[data-line],[data-pick],[data-up]');
    if (!t) return;
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
        var text = JSON.stringify(config, null, 2);
        var done = function () { say('Setup copied. Paste it into Import on another computer.'); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () { window.prompt('Copy this setup:', JSON.stringify(config)); });
        } else {
          window.prompt('Copy this setup:', JSON.stringify(config));
        }
        break;
      }
      case 'import': {
        var raw = window.prompt('Paste a setup copied from “Copy setup”:');
        if (!raw) break;
        try {
          config = mergeConfig(JSON.parse(raw));
          saveConfig();
          say('Setup imported.');
        } catch (err) {
          say('That setup could not be read: ' + err.message, true);
        }
        break;
      }
      case 'reset':
        if (window.confirm('Reset all Coupa settings in this panel to the defaults?')) {
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
    else if (t.hasAttribute('data-autosave')) config.autoSave = t.checked;
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
