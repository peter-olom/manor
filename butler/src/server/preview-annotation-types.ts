export type OperatorPreviewAnnotationViewport = {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  documentWidth: number;
  documentHeight: number;
};

export type OperatorPreviewAnnotation = {
  id: string;
  number: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  note: string;
  viewport: OperatorPreviewAnnotationViewport | null;
};

export type OperatorPreviewAnnotationBatch = {
  id: string;
  at: number;
  intent: "batch" | "insert";
  leaseId: string;
  targetId: string;
  page: { title: string; url: string };
  annotations: OperatorPreviewAnnotation[];
};
