// Test Worker pane task output rendering
export default async ({ browser, context, page, args, artifacts }) => {
  const url = 'http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split';
  await page.goto(url);
  // Wait for initial load
  await page.waitForTimeout(3000);
  // Take full-page screenshot
  await page.screenshot({ path: 'qa-output/full.png', fullPage: true });

  // Evaluate Worker pane
  const workerPaneInfo = await page.evaluate(() => {
    // Helper to find element by text content (case-insensitive)
    const findElementByText = (text, root = document) => {
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT,
        null,
        false
      );
      let node;
      while ((node = walker.nextNode())) {
        if (node.textContent && node.textContent.trim().includes(text)) {
          return node;
        }
      }
      return null;
    };

    // Locate the Worker pane (right pane in split view)
    // Look for a container that splits into two panes
    const splitContainer = document.querySelector('.split-view, .pane-container, [data-view="split"]');
    let workerPane = null;
    if (splitContainer) {
      const panes = splitContainer.querySelectorAll('.pane, .panel, [role="region"]');
      if (panes.length >= 2) {
        // Assume second pane is Worker (right side)
        workerPane = panes[1];
      }
    } else {
      // Fallback: look for element with "Worker" in header
      const workerHeader = findElementByText('Worker');
      if (workerHeader) {
        workerPane = workerHeader.closest('.pane, .panel, [role="region"]');
      }
    }

    if (!workerPane) {
      return { error: 'Could not locate Worker pane' };
    }

    // Locate timeline within Worker pane
    const timeline = workerPane.querySelector('.timeline, .output-timeline, [role="timeline"]');
    if (!timeline) {
      return { error: 'Could not locate timeline in Worker pane' };
    }

    // Check for "All outputs (N)" disclosure at top of timeline
    const allOutputsDisclosure = Array.from(timeline.children).find(child => 
      child.textContent && /All outputs\s*\(\d+\)/.test(child.textContent.trim())
    );

    // Locate worker report (look for common class names)
    const workerReport = workerPane.querySelector('.worker-report, .report, .task-output');
    let inlineOutputManifest = null;
    if (workerReport) {
      // Look for output manifest after worker report
      const next = workerReport.nextElementSibling;
      if (next && next.textContent && /output\s*manifest/i.test(next.textContent.trim())) {
        inlineOutputManifest = next;
      }
    }

    // Check if output manifest is pinned at bottom (fixed position)
    let outputManifestPinnedBottom = false;
    const outputManifestEl = workerPane.querySelector('[class*="output-manifest"], .output-manifest');
    if (outputManifestEl) {
      const style = window.getComputedStyle(outputManifestEl);
      if (style.position === 'fixed' && (style.bottom === '0px' || style.bottom === '0')) {
        outputManifestPinnedBottom = true;
      }
    }

    // Gather visible output entries in timeline
    const outputEntries = Array.from(timeline.querySelectorAll('.output-entry, .timeline-item, [role="listitem"]'));
    const entryTexts = outputEntries.map(el => el.textContent.trim()).filter(text => text.length > 0);

    return {
      allOutputsDisclosureText: allOutputsDisclosure ? allOutputsDisclosure.textContent.trim() : null,
      inlineOutputManifestPresent: !!inlineOutputManifest,
      outputManifestPinnedBottom: outputManifestPinnedBottom,
      outputEntriesCount: entryTexts.length,
      outputEntries: entryTexts.slice(0, 10) // first 10 entries
    };
  });

  console.log('Worker pane info:', workerPaneInfo);
  return workerPaneInfo;
};
