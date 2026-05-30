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
    pdfReadingFile?: DesktopFileBridge;
    pdfReadingApp?: DesktopAppBridge;
  }
}

export const defaultAssistantSettings: AssistantSettings = {
  providerMode: "auto",
  cloudProvider: "gpt",
  apiKey: "",
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
    if (desktopSettings) return { ...defaultAssistantSettings, ...desktopSettings };

    const saved = parseJson<Partial<AssistantSettings>>(window.localStorage.getItem(assistantSettingsKey()));
    return { ...defaultAssistantSettings, ...saved };
  },

  saveAssistantSettings(settings: AssistantSettings) {
    if (window.pdfReadingStorage?.saveAssistantSettings(settings)) return;
    window.localStorage.setItem(assistantSettingsKey(), JSON.stringify(settings));
  }
};
