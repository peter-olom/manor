// Test script for verifying the task output bar in the Worker pane
export default async ({ page, context, browser, cdpUrl, args, artifacts }) => {
  const url = "http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split";

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000); // Wait 3 seconds as per instructions
  // Wait for the task output bar to appear as a sign that the Worker pane is loaded
  const taskBarSelector = 'text=/Task.*output/i';
  await page.waitForSelector(taskBarSelector, { state: 'visible', timeout: 10000 });

  // Get the task bar element
  const taskBar = await page.$(taskBarSelector);

  // Find the Worker pane by traversing up from the task bar until we find a scrollable region or a role=region
  const workerPane = await taskBar.evaluate(async (el) => {
    let current = el;
    while (current && current !== document.body) {
      const style = window.getComputedStyle(current);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflow === 'auto' || style.overflow === 'scroll') {
        // Additionally, check if it's a region or has a role that suggests a pane
        if (current.getAttribute('role') === 'region' || current.classList.contains('pane') || current.classList.contains('panel')) {
          return current;
        }
      }
      // Also check if it's a div that might be a pane
      if (current.tagName === 'DIV' && (current.getAttribute('role') === 'region' || current.getAttribute('aria-label')?.includes('Worker'))) {
        return current;
      }
      current = current.parentElement;
    }
    // Fallback: return the body if nothing found
    return document.body;
  });

  // Scroll to the bottom of the Worker pane
  await workerPane.evaluate(el => {
    el.scrollTop = el.scrollHeight;
  });

  // Wait a bit for any animations
  await page.waitForTimeout(1000);

  // Take a screenshot of the collapsed state
  await page.screenshot({ path: 'qa-output/1-worker-pane-collapsed.png', fullPage: false });

  // Now check the task output bar in the collapsed state
  // We need to find the task output bar. Let's assume it's a sticky bar at the bottom of the Worker pane.
  // We'll look for an element that contains the text "Task outputs · N available" and is sticky.
  const collapsedTaskBar = await workerPane.$('text=/Task outputs · \\d+ available/i');
  if (!taskBar) {
    console.error('Task output bar not found in collapsed state');
    process.exit(1);
  }

  // Check if it's sticky (position: sticky or fixed)
  const isSticky = await taskBar.evaluate(el => {
    const style = window.getComputedStyle(el);
    return style.position === 'sticky' || style.position === 'fixed';
  });

  // Check for box-shadow (elevation glow)
  const hasBoxShadow = await taskBar.evaluate(el => {
    const style = window.getComputedStyle(el);
    return style.boxShadow !== 'none' && style.boxShadow !== '';
  });

  // Check the text content
  const barText = await taskBar.evaluate(el => el.textContent.trim());
  const hasTaskOutputsText = /Task outputs · \d+ available/i.test(barText);

  // Click the bar to expand it
  await taskBar.click();
  await page.waitForTimeout(1000); // Wait for expansion

  // Take a screenshot of the expanded state
  await page.screenshot({ path: 'qa-output/2-worker-pane-expanded.png', fullPage: false });

  // Now check the expanded panel for entries
  // We'll get all candidate elements inside the Worker pane and filter for visibility.
  const candidateSelectors = '.task-output-entry, .task-entry, [data-testid*="task-output"]';
  const allElements = await workerPane.$$(candidateSelectors);
  const entries = [];
  for (const el of allElements) {
    if (await el.isVisible()) {
      entries.push(el);
    }
  }
  if (entries.length === 0) {
    console.error('Could not find visible task output entries in Worker pane');
    process.exit(1);
  }

  if (entries.length === 0) {
    console.error('No task output entries found');
    process.exit(1);
  }

  // Check each entry for time, title, kind, and buttons
  let hasTime = true;
  let hasTitle = true;
  let hasKind = true;
  let hasOpenButton = true;
  let hasDownloadButton = true;
  let times = [];

  for (const entry of entries) {
    const text = await entry.evaluate(el => el.textContent);
    // Look for a time pattern like "05:10 PM"
    const timeMatch = text.match(/\d{1,2}:\d{2}\s*(AM|PM)/i);
    if (!timeMatch) hasTime = false;
    else times.push(timeMatch[0]);

    // Check for title, kind, and buttons by looking for typical elements
    const hasTitleElement = await entry.evaluate(el => el.querySelector('.title, [data-testid*="title"], h3, h4') !== null);
    const hasKindElement = await entry.evaluate(el => el.querySelector('.kind, [data-testid*="kind"], .type') !== null);
    const hasOpenButton = await entry.evaluate(el => el.querySelector('button[title*="Open"], button:has-text("Open"), [data-testid*="open"]') !== null);
    const hasDownloadButton = await entry.evaluate(el => el.querySelector('button[title*="Download"], button:has-text("Download"), [data-testid*="download"]') !== null);

    if (!hasTitleElement) hasTitle = false;
    if (!hasKindElement) hasKind = false;
    if (!hasOpenButton) hasOpenButton = false;
    if (!hasDownloadButton) hasDownloadButton = false;
  }

  // Check if times are in descending order (newest first)
  let timesAreDescending = true;
  if (times.length > 1) {
    const toMinutes = (timeStr) => {
      const [time, period] = timeStr.split(' ');
      let [hours, minutes] = time.split(':').map(Number);
      if (period.toUpperCase() === 'PM' && hours !== 12) hours += 12;
      if (period.toUpperCase() === 'AM' && hours === 12) hours = 0;
      return hours * 60 + minutes;
    };
    const minutes = times.map(toMinutes);
    for (let i = 0; i < minutes.length - 1; i++) {
      if (minutes[i] < minutes[i + 1]) {
        timesAreDescending = false;
        break;
      }
    }
  }

  // Report the results
  console.log('=== TASK OUTPUT BAR VERIFICATION ===');
  console.log(`Task bar sticky: ${isSticky}`);
  console.log(`Task bar has box-shadow (elevation): ${hasBoxShadow}`);
  console.log(`Task bar text matches pattern: ${hasTaskOutputsText} (${barText})`);
  console.log(`Entries have time: ${hasTime}`);
  console.log(`Entries have title: ${hasTitle}`);
  console.log(`Entries have kind: ${hasKind}`);
  console.log(`Entries have Open button: ${hasOpenButton}`);
  console.log(`Entries have Download button: ${hasDownloadButton}`);
  console.log(`Times are descending (newest first): ${timesAreDescending}`);

  // Determine if all checks pass
  const allChecksPass = isSticky && hasBoxShadow && hasTaskOutputsText && hasTime && hasTitle && hasKind && hasOpenButton && hasDownloadButton && timesAreDescending;
  console.log(`All checks passed: ${allChecksPass}`);

  // Exit with appropriate code
  process.exit(allChecksPass ? 0 : 1);
};