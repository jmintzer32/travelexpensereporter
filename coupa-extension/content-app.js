// Runs only on the Travel Expense Reporter app (see manifest.json "matches").
// Lets the app know the extension is installed, and forwards the expenses the
// app sends to the extension's background worker.

document.documentElement.setAttribute(
  'data-coupa-filler-extension',
  chrome.runtime.getManifest().version
);

window.addEventListener('SYNC_COUPA_EXPENSES', (event) => {
  let payload;
  try {
    payload = JSON.parse(event.detail);
  } catch (e) {
    console.error('Coupa Filler: could not read expenses from the app', e);
    return;
  }
  if (!payload || payload.source !== 'travel-expense-reporter' || !Array.isArray(payload.trips)) {
    return;
  }
  chrome.runtime.sendMessage({ type: 'SAVE_EXPENSES', data: payload });
});
