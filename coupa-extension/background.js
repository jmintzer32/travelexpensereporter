// This background script listens for messages from the web app (via content-app.js)
// and stores the expenses in the extension's local storage.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SAVE_EXPENSES') {
    const expenses = message.data;
    
    // Save to extension local storage
    chrome.storage.local.set({ pendingExpenses: expenses }, () => {
      console.log('Saved expenses to extension storage:', expenses);
      
      // Optional: Update the extension badge to show how many expenses are pending
      chrome.action.setBadgeText({ text: expenses.length.toString() });
      chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' }); // Indigo color
      
      sendResponse({ success: true });
    });
    
    return true; // Keep message channel open for async response
  }
});
