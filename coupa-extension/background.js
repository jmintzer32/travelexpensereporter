// Stores the expenses sent from the web app (via content-app.js) until the
// popup injects them into the Coupa tab.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SAVE_EXPENSES') {
    const payload = message.data;

    chrome.storage.local.set({ pendingPayload: payload }, () => {
      const lineCount = payload.trips.reduce((n, trip) => n + trip.lines.length, 0);
      chrome.action.setBadgeText({ text: String(lineCount) });
      chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' });
      sendResponse({ success: true });
    });

    return true; // Keep message channel open for async response
  }
});
