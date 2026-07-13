export type AnnotationRect = { x: number; y: number; width: number; height: number };
export type PdfAnnotation = AnnotationRect & { id: string; pageNumber: number; text: string; wholePage?: boolean };
type PdfViewport = { width: number; height: number; convertToPdfPoint: (x: number, y: number) => number[] };

export function pdfLabelOrigin(centerX: number, centerY: number, textWidth: number, fontSize: number, rotation: number): { x: number; y: number } {
  const radians = rotation * Math.PI / 180;
  const localCenterX = textWidth / 2;
  const localCenterY = fontSize * 0.35;
  return {
    x: centerX - (Math.cos(radians) * localCenterX - Math.sin(radians) * localCenterY),
    y: centerY - (Math.sin(radians) * localCenterX + Math.cos(radians) * localCenterY)
  };
}

export function pdfRectFromViewport(viewport: PdfViewport, annotation: AnnotationRect): { x: number; y: number; width: number; height: number } {
  const first = viewport.convertToPdfPoint(annotation.x * viewport.width, annotation.y * viewport.height);
  const second = viewport.convertToPdfPoint((annotation.x + annotation.width) * viewport.width, (annotation.y + annotation.height) * viewport.height);
  const x = Math.min(first[0] ?? 0, second[0] ?? 0);
  const y = Math.min(first[1] ?? 0, second[1] ?? 0);
  return { x, y, width: Math.abs((second[0] ?? 0) - (first[0] ?? 0)), height: Math.abs((second[1] ?? 0) - (first[1] ?? 0)) };
}

export function buildPdfAnnotationPrompt(annotations: PdfAnnotation[]): string {
  return [
    "Please follow up on the numbered tags in the attached annotated PDF.",
    "",
    ...annotations.map((annotation, index) => `${index + 1}. Page ${annotation.pageNumber}${annotation.wholePage ? " (whole page)" : ""}: ${annotation.text.trim()}`)
  ].join("\n");
}

export function buildAnnotatedPdfName(name: string): string {
  const withoutExtension = name.trim().replace(/\.[^.]+$/, "") || "document";
  const safeBase = withoutExtension.replace(/[\\/:*?"<>|]+/g, "-").trim() || "document";
  return `${safeBase}-annotated.pdf`;
}
