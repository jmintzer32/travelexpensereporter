document.addEventListener('DOMContentLoaded', () => {
  const statusBox = document.getElementById('status-box');
  const fillBtn = document.getElementById('fill-btn');
  let pendingData = [];

  // Check storage for expenses sent from the web app
  chrome.storage.local.get(['pendingExpenses'], (result) => {
    if (result.pendingExpenses && result.pendingExpenses.length > 0) {
      pendingData = result.pendingExpenses;
      statusBox.innerHTML = `<strong>Ready!</strong><br>${pendingData.length} expenses are waiting to be synced.`;
      fillBtn.disabled = false;
    } else {
      statusBox.innerHTML = `No expenses found. Go to the Travel Expense Reporter app and click "Send to Coupa Extension".`;
      fillBtn.disabled = true;
    }
  });

  // Handle the click event to inject the script into the active tab
  fillBtn.addEventListener('click', async () => {
    // Get the current active tab (which should be Coupa)
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab.url.toLowerCase().includes('coupa')) {
      const confirmRun = confirm("This doesn't look like a Coupa URL. Are you sure you want to run the automation here?");
      if (!confirmRun) return;
    }

    fillBtn.disabled = true;
    fillBtn.innerText = "Injecting...";

    // Inject the content script into the Coupa page
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content-coupa.js']
    }, () => {
      // After injecting, send the message to start filling
      chrome.tabs.sendMessage(tab.id, { type: 'START_FILLING', data: pendingData }, (response) => {
        window.close(); // Close the popup
      });
    });
  });
});
