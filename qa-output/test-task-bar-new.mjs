export default async ({ page, context, browser, cdpUrl, args, artifacts }) => {
  const url = "http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split";

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000); // Wait 3 seconds as per instructions

  // Look for an element that contains the text "Worker" to find the Worker pane
  const workerPaneLabel = await page.$('text=Worker', { state: 'visible' });
  if (!workerPaneLabel) {
    console.error('Could not find Worker pane label');
    process.exit(1);
  }

  // From the label, go up to find a parent that is a pane (role=region or has a class)
  const workerPane = await workerPaneLabel.evaluate(async (el) => {
    let current = el;
    while (current && current !== document.body) {
      if (current.getAttribute('role') === 'region' || 
          current.classList.contains('pane') || 
          current.classList.contains('panel') ||
          (current.tagName === 'DIV' && current.getAttribute('aria-label')?.includes('Worker'))) {
        return current;
      }
      current = current.parentElement;
    }
    return document.body;
  });

  // Scroll to the bottom of the Worker pane
  await workerPane.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(1000);

  // Take a screenshot of the collapsed state
  await page.screenshot({ path: 'qa-output/1-worker-pane-collapsed.png', fullPage: false });

  // Find the task output bar within the Worker pane
  const taskBar = await workerPane.$('text=/Task outputs \\\\d+ available/i');
  if (!taskBar) {
    console.error('Task output bar not found');
    process.exit(1);
  }

  // Check sticky and box-shadow
  const isSticky = await taskBar.evaluate(el => {
    const style = window.getComputedStyle(el);
    return style.position === 'sticky' || style.position === 'fixed';
  });
  const hasBoxShadow = await taskBar.evaluate(el => {
    const style = window.getComputedStyle(el);
    return style.boxShadow !== 'none' && style.boxShadow !== '';
  });
  const barText = await taskBar.evaluate(el => el.textContent.trim());
  const hasTaskOutputsText = /Task outputs \\\\d+ available/i.test(barText);

  // Click to expand
  await taskBar.click();
  await page.waitForTimeout(1000);

  // Take a screenshot of the expanded state
  await page.screenshot({ path: 'qa-output/2-worker-pane-expanded.png', fullPage: false });

  // Get all entries in the Worker pane
  const entries = await workerPane.$$('.task-output-entry, .task-entry, [data-testid*="task-output"]');
  const visibleEntries = [];
  for (const el of entries) {
    if (await el.isVisible()) {
      visibleEntries.push(el);
    }
  }
  if (visibleEntries.length === 0) {
    console.error('No visible task output entries found');
    process.exit(1);
  }

  // Check each entry
  let hasTime = true, hasTitle = true, hasKind = true, hasOpenButton = true, hasDownloadButton = true;
  let times = [];
  for (const entry of visibleEntries) {
    const text = await entry.evaluate(el => el.textContent);
    // Look for a time pattern like "05:10 PM"
    const timeMatch = text.match(/\\d{1,2}:\\d{2}\\s*(AM|PM)/i);
    if (!timeMatch) hasTime = false;
    else times.push(timeMatch[0]);

    const hasTitleElement = await entry.evaluate(el => el.querySelector('.title, [data-testid*="title"], h3, h4') !== null);
    const hasKindElement = await entry.evaluate(el => el.querySelector('.kind, [data-testid*="kind"], .type') !== null);
    const hasOpenButton = await entry.evaluate(el => el.querySelector('button[title*="Open"], button:has-text("Open"), [data-testid*="open"]') !== null);
    const hasDownloadButton = await entry.evaluate(el => el.querySelector('button[title*="Download"], button:has-text("Download"), [data-testid*="download"]') !== null);

    if (!hasTitleElement) hasTitle = false;
    if (!hasKindElement) hasKind = false;
    if (!hasOpenButton) hasOpenButton = false;
    if (!hasDownloadButton) hasDownloadButton = false;
  }

  // Check times descending
  let timesAreDescending = true;
  if (times.length > 1) {
    const toMinutes = (timeStr) => {
      const [time, period] = timeStr.split(' ');
      let [hours, minutes] = time.split(':').map(Number);
      if (period.toUpperCase() === 'PM' && hours !== 12) hours += 12;
      if (period.toUpperCase() === 'AM' && hours === 12) hours = 0;
      return hours * 60 + minutes;
    };
    const minutes = times.map(t => toMinutes(t));
    for (let i = 0; i < minutes.length - 1; i++) {
      if (minutes[i] < minutes[i + 1]) {
        timesAreDescending = false;
        break;
      }
    }
  }

  // Output results
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

  const allChecksPass = isSticky && hasBoxShadow && hasTaskOutputsText && hasTime && hasTitle && hasKind && hasOpenButton && hasDownloadButton && timesAreDescending;
  console.log(`All checks passed: ${allChecksPrintf}`);

  // Exit with appropriate code
  process.exit(allChecksPrintf ? 0 : 1);
};