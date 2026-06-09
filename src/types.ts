export type PaperSource = {
  id: string;
  name: string;
  size: number;
  openedAt: string;
  objectUrl: string;
};

export type ReadingState = {
  currentPage: number;
  pageCount: number;
  scale: number;
  rotation: number;
  fitMode: "width" | "page" | "free";
  spreadMode: "single" | "double";
  flowMode: "paged" | "scroll";
};

export type AnnotationStyle = "highlight" | "underline";

export type ToolMode = "annotate" | "select";

export type AnnotationRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PaperAnnotation = {
  id: string;
  paperKey: string;
  page: number;
  rect: AnnotationRect;
  color: string;
  style: AnnotationStyle;
  hasNote: boolean;
  note: string;
  createdAt: string;
  updatedAt: string;
};

export type AnnotationTool = {
  color: string;
  style: AnnotationStyle;
  mode: ToolMode;
};

export type AssistantMode = "translate" | "explain" | "ask";

export type PaperSheetNote = {
  id: string;
  paperKey: string;
  page: number;
  title: string;
  content: string;
  height: number;
  createdAt: string;
  updatedAt: string;
};

export type CloudProvider = "gpt" | "gemini" | "deepseek" | "qwen";

export type AssistantSettings = {
  providerMode: "auto" | "local" | "cloud";
  cloudProvider: CloudProvider;
  apiKeys: Record<CloudProvider, string>;
  sourceLanguage: string;
  targetLanguage: string;
};

export type DocumentSaveData = {
  version: number;
  paperKey: string;
  annotations: PaperAnnotation[];
  sheetNotes: PaperSheetNote[];
  reading?: Pick<ReadingState, "currentPage" | "scale" | "rotation" | "spreadMode" | "flowMode">;
  updatedAt: string;
};
