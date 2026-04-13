// This script is injected into the Coupa tab when the user clicks "Fill Report" in the popup.

// Helper function to simulate typing into modern web framework inputs (React, Angular, etc.)
function setInputValue(element, value) {
  if (!element) return;
  
  const valueSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set;
  const prototype = Object.getPrototypeOf(element);
  const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  
  if (valueSetter && valueSetter !== prototypeValueSetter) {
      prototypeValueSetter.call(element, value);
  } else if (valueSetter) {
      valueSetter.call(element, value);
  } else {
      element.value = value;
  }
  
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

// Helper function to wait for an element to appear in the DOM
function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve, reject) => {
      if (document.querySelector(selector)) {
          return resolve(document.querySelector(selector));
      }

      const observer = new MutationObserver((mutations) => {
          if (document.querySelector(selector)) {
              observer.disconnect();
              resolve(document.querySelector(selector));
          }
      });

      observer.observe(document.body, {
          childList: true,
          subtree: true
      });

      setTimeout(() => {
          observer.disconnect();
          reject(new Error(`Timeout waiting for ${selector}`));
      }, timeout);
  });
}

// Helper to pause execution
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fillCoupaExpenses(expenses) {
  console.log('Starting Coupa automation with expenses:', expenses);
  
  for (let i = 0; i < expenses.length; i++) {
      const expense = expenses[i];
      console.log(`Processing expense ${i + 1}/${expenses.length}:`, expense);

      try {
          // =====================================================================
          // IMPORTANT: YOU WILL NEED TO UPDATE THESE CSS SELECTORS FOR YOUR COUPA
          // Every company's Coupa instance has slightly different HTML IDs/Classes.
          // Right-click -> "Inspect" on the Coupa fields to find the correct IDs.
          // =====================================================================

          // 1. Click the "Add Line" or "New Expense" button
          const addLineBtnSelector = '#add_expense_line_button'; // <-- UPDATE THIS
          const addBtn = await waitForElement(addLineBtnSelector);
          addBtn.click();
          
          // Wait for the modal or form to open
          await sleep(1500);

          // 2. Fill in the Date
          const dateInputSelector = 'input[name="expense_date"]'; // <-- UPDATE THIS
          const dateInput = await waitForElement(dateInputSelector);
          // Coupa might expect MM/DD/YYYY instead of YYYY-MM-DD. Format if necessary:
          // const [y, m, d] = expense.date.split('-');
          // setInputValue(dateInput, `${m}/${d}/${y}`);
          setInputValue(dateInput, expense.date);

          // 3. Fill in the Merchant
          const merchantInputSelector = 'input[name="merchant"]'; // <-- UPDATE THIS
          const merchantInput = await waitForElement(merchantInputSelector);
          setInputValue(merchantInput, expense.merchant);

          // 4. Fill in the Amount
          const amountInputSelector = 'input[name="amount"]'; // <-- UPDATE THIS
          const amountInput = await waitForElement(amountInputSelector);
          setInputValue(amountInput, expense.amount.toString());

          // 5. Fill in the Description
          const descInputSelector = 'textarea[name="description"]'; // <-- UPDATE THIS
          const descInput = await waitForElement(descInputSelector);
          setInputValue(descInput, expense.description);

          // 6. Click "Save" for this line item
          const saveLineBtnSelector = '#save_expense_line_button'; // <-- UPDATE THIS
          const saveBtn = await waitForElement(saveLineBtnSelector);
          saveBtn.click();

          // Wait a moment for Coupa to save and close the modal before doing the next one
          await sleep(2000);

      } catch (error) {
          console.error(`Failed to process expense ${expense.merchant}:`, error);
          alert(`Automation paused. Could not find an element on the page. Check the console for details.`);
          break; // Stop the loop if we hit an error so it doesn't go crazy
      }
  }
  
  alert('Finished processing expenses!');
}

// Listen for the command from the popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_FILLING') {
      fillCoupaExpenses(message.data);
      sendResponse({ status: 'started' });
  }
});
