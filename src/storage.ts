import type { AssistantSettings, DocumentSaveData } from "./types";

const namespace = "pdf-reading";
const documentVersion = 1;

type DesktopStorageBridge = {
  loadDocument: (paperKey: string) => DocumentSaveData | null;
  saveDocument: (data: DocumentSaveData) => boolean;
  loadAssistantSettings: () => Partial<AssistantSettings> | null;
  saveAssistantSettings: (settings: AssistantSettings) => boolean;
};

type DesktopTranslatorBridge = {
  translate: (request: { text: string; sourceLanguage: string; targetLanguage: string }) => Promise<string>;
};

type DesktopAssistantBridge = {
  run: (request: {
    mode: "translate" | "ask";
    provider: "gpt" | "gemini" | "deepseek" | "qwen";
    text: string;
    page: number;
    question?: string;
    targetLanguage: string;
  }) => Promise<string>;
};

type DesktopTextBridge = {
  extractPage: (request: {
    data: ArrayBuffer;
    page: number;
    scale: number;
    rotation: number;
  }) => Promise<unknown>;
  selectText: (request: {
    data: ArrayBuffer;
    page: number;
    scale: number;
    rotation: number;
    start: { x: number; y: number };
    end: { x: number; y: number };
  }) => Promise<unknown>;
};

type DesktopRenderBridge = {
  renderPage: (request: {
    data: ArrayBuffer;
    page: number;
    scale: number;
    rotation: number;
    annotations?: Array<{
      color: string;
      style: string;
      rects: Array<{ x: number; y: number; width: number; height: number }>;
    }>;
  }) => Promise<unknown>;
};

type DesktopOcrBridge = {
  extractPage: (request: {
    data: ArrayBuffer;
    page: number;
    width: number;
    height: number;
    scale: number;
    rotation: number;
  }) => Promise<unknown>;
};

type DesktopFileBridge = {
  savePdf: (request: { defaultName: string; data: ArrayBuffer }) => Promise<{ canceled: boolean; filePath?: string }>;
};

type DesktopAppBridge = {
  ready: () => void;
};

declare global {
  interface Window {
    pdfReadingStorage?: DesktopStorageBridge;
    pdfReadingTranslator?: DesktopTranslatorBridge;
    pdfReadingAssistant?: DesktopAssistantBridge;
    pdfReadingText?: DesktopTextBridge;
    pdfReadingRender?: DesktopRenderBridge;
    pdfReadingOcr?: DesktopOcrBridge;
    pdfReadingFile?: DesktopFileBridge;
    pdfReadingApp?: DesktopAppBridge;
  }
}

export const defaultAssistantSettings: AssistantSettings = {
  providerMode: "auto",
  cloudProvider: "gpt",
  apiKeys: {
    gpt: "",
    gemini: "",
    deepseek: "",
    qwen: ""
  },
  sourceLanguage: "en",
  targetLanguage: "zh"
};

function documentStorageKey(paperKey: string) {
  return `${namespace}:document:${paperKey}`;
}

function assistantSettingsKey() {
  return `${namespace}:assistant-settings`;
}

export function getPaperKey(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

type LegacyAssistantSettings = Partial<AssistantSettings> & { apiKey?: string };

function normalizeAssistantSettings(saved?: LegacyAssistantSettings | null): AssistantSettings {
  const legacyApiKey = saved?.apiKey?.trim();
  return {
    ...defaultAssistantSettings,
    ...saved,
    apiKeys: {
      ...defaultAssistantSettings.apiKeys,
      ...(saved?.apiKeys ?? {}),
      ...(legacyApiKey ? { gpt: legacyApiKey } : {})
    }
  };
}

export const storage = {
  loadDocument(paperKey: string): DocumentSaveData {
    const desktopDocument = window.pdfReadingStorage?.loadDocument(paperKey);
    if (desktopDocument?.version === documentVersion) return desktopDocument;

    const savedDocument = parseJson<DocumentSaveData>(window.localStorage.getItem(documentStorageKey(paperKey)));
    if (savedDocument?.version === documentVersion) return savedDocument;

    return {
      version: documentVersion,
      paperKey,
      annotations: [],
      sheetNotes: [],
      updatedAt: new Date().toISOString()
    };
  },

  saveDocument(data: Omit<DocumentSaveData, "version" | "updatedAt">) {
    const payload: DocumentSaveData = {
      ...data,
      version: documentVersion,
      updatedAt: new Date().toISOString()
    };

    if (window.pdfReadingStorage?.saveDocument(payload)) return;
    window.localStorage.setItem(documentStorageKey(data.paperKey), JSON.stringify(payload));
  },

  loadAssistantSettings(): AssistantSettings {
    const desktopSettings = window.pdfReadingStorage?.loadAssistantSettings();
    if (desktopSettings) return normalizeAssistantSettings(desktopSettings);

    const saved = parseJson<LegacyAssistantSettings>(window.localStorage.getItem(assistantSettingsKey()));
    return normalizeAssistantSettings(saved);
  },

  saveAssistantSettings(settings: AssistantSettings) {
    if (window.pdfReadingStorage?.saveAssistantSettings(settings)) return;
    window.localStorage.setItem(assistantSettingsKey(), JSON.stringify(settings));
  }
};
