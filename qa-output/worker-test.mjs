// Test Worker pane task output rendering
export default async ({ browser, context, page, args, artifacts }) => {
  const url = 'http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split';
  await page.goto(url);
  // Wait for initial load
  await page.waitForTimeout(3000);
  // Take full-page screenshot
  await page.screenshot({ path: 'qa-output/full.png', fullPage: true });

  // Focus on Worker pane and extract info
  const workerInfo = await page.evaluate(() => {
    const getText = el => el ? el.textContent.trim() : null;

    // Locate Worker pane (right pane in split view)
    const workerPane = document.querySelector('[aria-label="Worker lane"]');
    if (!workerPane) {
      return { error: 'Worker pane not found' };
    }

    // 1. Check for "All outputs (N)" disclosure at top of timeline
    const timeline = workerPane.querySelector('.worker-timeline');
    if (!timeline) {
      return { error: 'Worker timeline not found' };
    }

    const allOutputsDisclosure = timeline.querySelector('.worker-output-summary summary');
    const allOutputsText = allOutputsDisclosure ? getText(allOutputsDisclosure) : null;
    const hasAllOutputsDisclosure = allOutputsText && /All outputs\s*\(\d+\)/.test(allOutputsText);

    // 2. Find the worker report item (first item in the summary list)
    const reportItem = timeline.querySelector('.worker-output-summary-item');
    const reportExists = !!reportItem;

    // 3. Look for inline output manifest section after the worker report
    // We'll consider the worker report as the content of the worker-turn (the detailed activity)
    const workerTurn = timeline.querySelector('.worker-turn');
    const outputManifestAfterReport = workerTurn ? workerTurn.querySelector('[class*="output-manifest"], [class*="manifest"]') : null;
    const inlineOutputManifestPresent = !!outputManifestAfterReport;

    // 4. Check if output manifest is pinned at the bottom (should NOT be)
    // Look for any element with fixed position at bottom within the Worker pane
    const pinnedBottom = Array.from(workerPane.querySelectorAll('*')).some(el => {
      const style = window.getComputedStyle(el);
      return style.position === 'fixed' && 
             (style.bottom === '0px' || style.bottom === '0') &&
             el.offsetWidth > 0 && el.offsetHeight > 0;
    });
    const outputManifestPinnedBottom = pinnedBottom; // true if found, but we expect false

    // 5. List visible output entries (from the summary list items)
    const outputItems = timeline.querySelectorAll('.worker-output-summary-item');
    const outputEntries = Array.from(outputItems).map(item => {
      const kindEl = item.querySelector('.worker-output-kind');
      const textEl = item.querySelector('strong');
      return {
        kind: kindEl ? getText(kindEl) : null,
        text: textEl ? getText(textEl) : null
      };
    });

    return {
      allOutputsDisclosureText: allOutputsText,
      hasAllOutputsDisclosure,
      reportExists,
      inlineOutputManifestPresent,
      outputManifestPinnedBottom: outputManifestPinnedBottom, // true if pinned (bad)
      outputEntriesCount: outputItems.length,
      outputEntries
    };
  });

  console.log('Worker pane info:', workerInfo);
  // Take a screenshot of the Worker pane for evidence
  const workerPane = await page.$('[aria-label="Worker lane"]');
  if (workerPane) {
    await workerPane.screenshot({ path: 'qa-output/worker-pane.png' });
  }
  return workerInfo;
};
