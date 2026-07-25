export default async ({ page, artifacts }) => {
  await page.goto('http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split');
  // Wait for network idle
  await page.waitForLoadState('networkidle');
  // Additional wait for any animations
  await page.waitForTimeout(3000);
  // Screenshot
  await page.screenshot({ path: 'qa-output/manor.png', fullPage: true });
  // Layout check
  const layoutOk = await page.evaluate(() => {
    // Try to find the review verdict panel: look for element containing "Accepted" badge
    const verdictEl = Array.from(document.querySelectorAll('*')).find(el => 
      el.textContent && el.textContent.includes('Accepted') && 
      el.getAttribute('class') && el.getAttribute('class').includes('badge')
    );
    if (!verdictEl) {
      console.warn('Verdict badge not found');
      return false;
    }
    // Assume the verdict panel is the closest ancestor with some padding or role
    let verdictPanel = verdictEl.parentElement;
    while (verdictPanel && !verdictPanel.classList.contains('verdict-panel') && 
           !verdictPanel.classList.contains('review-verdict') &&
           !verdictPanel.classList.contains('panel')) {
      verdictPanel = verdictPanel.parentElement;
    }
    if (!verdictPanel) verdictPanel = verdictEl.parentElement; // fallback
    // Find Butler pane: maybe container with id or class containing 'butler'
    const butlerPane = document.querySelector('[id*="butler"]') || 
                       document.querySelector('.butler') ||
                       document.querySelector('[class*="butler"]');
    if (!butlerPane) {
      console.warn('Butler pane not found');
      return false;
    }
    // Within Butler pane, find messages container: maybe after verdict panel
    // We'll just get all child elements of butlerPane and see ordering
    const butlerChildren = Array.from(butlerPane.children);
    // Find index of verdict panel
    const verdictIndex = butlerChildren.indexOf(verdictPanel);
    if (verdictIndex === -1) {
      console.warn('Verdict panel not a direct child of Butler pane');
      // try to see if verdictPanel is inside
      const contains = butlerPane.contains(verdictPanel);
      if (!contains) {
        console.warn('Verdict panel not inside Butler pane');
        return false;
      }
    }
    // Find messages container: assume it's the element after verdict panel that contains messages
    // Look for element with class containing 'message' or 'chat'
    let messagesContainer = null;
    for (let i = verdictIndex + 1; i < butlerChildren.length; i++) {
      const child = butlerChildren[i];
      if (child.classList && (child.classList.contains('messages') || 
                              child.classList.contains('chat-messages') ||
                              child.classList.contains('message-list'))) {
        messagesContainer = child;
        break;
      }
    }
    if (!messagesContainer) {
      console.warn('Messages container not found after verdict');
      return false;
    }
    const verdictRect = verdictPanel.getBoundingClientRect();
    const messagesRect = messagesContainer.getBoundingClientRect();
    const margin = messagesRect.top - verdictRect.bottom;
    console.log(`Verdict bottom: ${verdictRect.bottom}, Messages top: ${messagesRect.top}, margin: ${margin}`);
    const ok = margin > 5; // at least 5px gap
    // Also check that messages themselves have reasonable line-height? skip for now
    return ok;
  });
  console.log('Layout check result:', layoutOk);
  // Also check Worker pane renders normally: just ensure it exists and has some content
  const workerPane = document.querySelector('[id*="worker"]') || document.querySelector('.worker') || document.querySelector('[class*="worker"]');
  if (!workerPane) {
    console.warn('Worker pane not found');
    return { layoutOk: false, workerOk: false };
  }
  const workerOk = workerPane.offsetWidth > 0 && workerPane.offsetHeight > 0;
  console.log('Worker pane visible:', workerOk);
  return { layoutOk, workerOk };
};