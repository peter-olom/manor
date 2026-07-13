const MAX_CSS_DIMENSION = 32_000;
const MAX_RENDER_DIMENSION = 8_192;
const MAX_RENDER_PIXELS = 16_000_000;

export type PdfCanvasLayout = {
  cssScale: number;
  outputScale: number;
  pixelWidth: number;
  pixelHeight: number;
};

export function calculatePdfCanvasLayout(pageWidth: number, pageHeight: number, availableWidth: number, deviceScale: number): PdfCanvasLayout {
  const fitScale = Math.max(1, availableWidth - 32) / pageWidth;
  const cssScale = Math.max(0.001, Math.min(2, fitScale, MAX_CSS_DIMENSION / pageWidth, MAX_CSS_DIMENSION / pageHeight));
  const cssWidth = pageWidth * cssScale;
  const cssHeight = pageHeight * cssScale;
  const requestedOutputScale = Math.max(1, Math.min(deviceScale || 1, 2));
  const safeOutputScale = Math.min(
    requestedOutputScale,
    MAX_RENDER_DIMENSION / cssWidth,
    MAX_RENDER_DIMENSION / cssHeight,
    Math.sqrt(MAX_RENDER_PIXELS / (cssWidth * cssHeight))
  );
  const outputScale = Math.max(0.001, safeOutputScale);
  return {
    cssScale,
    outputScale,
    pixelWidth: Math.max(1, Math.floor(cssWidth * outputScale)),
    pixelHeight: Math.max(1, Math.floor(cssHeight * outputScale))
  };
}
