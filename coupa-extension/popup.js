document.addEventListener('DOMContentLoaded', () => {
  const statusBox = document.getElementById('status-box');
  const fillBtn = document.getElementById('fill-btn');
  let pendingPayload = null;

  // Check storage for expenses sent from the web app
  chrome.storage.local.get(['pendingPayload'], (result) => {
    const payload = result.pendingPayload;
    if (payload && payload.trips && payload.trips.length > 0) {
      pendingPayload = payload;
      const lineCount = payload.trips.reduce((n, trip) => n + trip.lines.length, 0);
      statusBox.innerHTML = `<strong>Ready!</strong><br>${payload.trips.length} trip(s), ${lineCount} expense lines are waiting.`;
    } else {
      statusBox.innerHTML = 'No expenses yet. In Travel Expense Reporter, click <b>Send</b> under “Chrome extension”. You can still open the filler and paste data.';
    }
    fillBtn.disabled = false;
  });

  // Inject the shared filler (same code as the bookmarklet) into the active tab.
  fillBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab.url || !tab.url.toLowerCase().includes('coupa')) {
      const confirmRun = confirm("This doesn't look like a Coupa page. Open the filler here anyway?");
      if (!confirmRun) return;
    }

    fillBtn.disabled = true;
    fillBtn.innerText = 'Opening…';

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN', // same context as the bookmarklet, so it sees Coupa's own jQuery
      files: ['coupa-filler.js']
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: (payload) => window.__coupaFiller.open(payload),
      args: [pendingPayload]
    });

    if (pendingPayload) {
      // Loaded into the panel (which remembers it), so clear the badge.
      chrome.storage.local.remove('pendingPayload');
      chrome.action.setBadgeText({ text: '' });
    }
    window.close();
  });
});
