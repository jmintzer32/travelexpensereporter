// This script runs on ALL pages, but it specifically listens for a custom event
// dispatched by our Travel Expense Reporter Angular application.

window.addEventListener('SYNC_COUPA_EXPENSES', (event) => {
  const expenses = event.detail;
  console.log('Extension intercepted expenses from web app:', expenses);
  
  // Send the data to the extension's background service worker
  chrome.runtime.sendMessage({ type: 'SAVE_EXPENSES', data: expenses }, (response) => {
    if (response && response.success) {
      console.log('Successfully sent to extension background.');
    }
  });
});
