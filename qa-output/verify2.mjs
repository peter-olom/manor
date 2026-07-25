export default async ({ page }) => {
  const url = 'http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split';
  await page.goto(url);
  // Wait for initial load
  await page.waitForTimeout(3000);
  // Screenshot
  await page.screenshot({ path: 'qa-output/manor.png', fullPage: true });
  // Layout check
  const result = await page.evaluate(() => {
    // Helper to get element by text content (case-insensitive)
    const elWithText = (text) => {
      const els = Array.from(document.querySelectorAll('*'));
      return els.find(el => el.textContent && el.textContent.trim().includes(text));
    };
    // Find Accepted badge
    const acceptedBadge = elWithText('Accepted');
    if (!acceptedBadge) {
      console.log('Accepted badge not found');
      return { layoutOk: false, workerOk: false, reason: 'Accepted badge missing' };
    }
    // Find Butler pane: look for container with class containing 'butler' or id
    const butlerPane = document.querySelector('[class*="butler"], [id*="butler"]');
    if (!butlerPane) {
      console.log('Butler pane not found');
      return { layoutOk: false, workerOk: false, reason: 'Butler pane missing' };
    }
    // Find Worker pane similarly
    const workerPane = document.querySelector('[class*="worker"], [id*="worker"]');
    if (!workerPane) {
      console.log('Worker pane not found');
      return { layoutOk: false, workerOk: false, reason: 'Worker pane missing' };
    }
    // Determine if Accepted badge is inside Butler pane
    if (!butlerPane.contains(acceptedBadge)) {
      console.log('Accepted badge not inside Butler pane');
      return { layoutOk: false, workerOk: false, reason: 'Accepted badge not in Butler pane' };
    }
    // Find messages container: assume it's an element within Butler pane that contains multiple message divs
    // Look for element with class containing 'message' or 'chat' that is a child of Butler pane
    const messageEls = Array.from(butlerPane.querySelectorAll('[class*="message"], [class*="chat"]'));
    let messagesContainer = null;
    if (messageEls.length > 0) {
      // Choose the one with most children maybe
      messagesContainer = messageEls.reduce((max, el) => {
        return el.children.length > max.children.length ? el : max;
      }, messageEls[0]);
    } else {
      // fallback: use Butler pane itself as container? Not ideal
      messagesContainer = butlerPane;
    }
    // Get bounding rect of Accepted badge (we'll use its parent maybe the verdict panel)
    const verdictEl = acceptedBadge.closest('.verdict-panel, .review-verdict, .panel, [class*="verdict"]') || acceptedBadge.parentElement;
    const verdictRect = verdictEl.getBoundingClientRect();
    // Get bounding rect of messages container
    const messagesRect = messagesContainer.getBoundingClientRect();
    const margin = messagesRect.top - verdictRect.bottom;
    console.log(`Verdict bottom: ${verdictRect.bottom}, Messages top: ${messagesRect.top}, margin: ${margin}`);
    const layoutOk = margin > 5; // at least 5px gap
    // Worker pane visibility
    const workerOk = workerPane.offsetWidth > 0 && workerPane.offsetHeight > 0;
    return { layoutOk, workerOk, margin };
  });
  console.log('Layout result:', result);
  return result;
};