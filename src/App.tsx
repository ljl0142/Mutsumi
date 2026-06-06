import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode, TextareaHTMLAttributes } from "react";
import {
  BookOpen,
  Bot,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Download,
  FileText,
  FolderOpen,
  GripHorizontal,
  Highlighter,
  Languages,
  MessageSquarePlus,
  MousePointer2,
  NotebookPen,
  PanelLeftClose,
  PanelRightClose,
  RotateCw,
  Search,
  Settings2,
  Trash2,
  Underline,
  X,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { pdfjsLib } from "./pdfWorker";
import { defaultAssistantSettings, getPaperKey, storage } from "./storage";
import type {
  AnnotationRect,
  AnnotationStyle,
  AnnotationTool,
  AssistantSettings,
  CloudProvider,
  DocumentSaveData,
  PaperAnnotation,
  PaperSheetNote,
  PaperSource,
  ReadingState
} from "./types";

type PdfDocument = Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>;

const initialReadingState: ReadingState = {
  currentPage: 1,
  pageCount: 0,
  scale: 1.15,
  rotation: 0,
  fitMode: "free",
  spreadMode: "single",
  flowMode: "paged"
};

const defaultTool: AnnotationTool = {
  color: "#f8d85a",
  style: "highlight",
  mode: "select"
};

const desktopReferenceSize = {
  width: 1440,
  height: 900
};

const toolColors = ["#f8d85a", "#9be7c0", "#8ec5ff", "#ffb1c8", "#c8b6ff"];

type TextSelectionState = {
  text: string;
  page: number;
  position: { left: number; top: number };
  rects?: AnnotationRect[];
};

type TextLine = {
  text: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
  start: number;
  end: number;
  line: number;
};

type TextCharBox = {
  char: string;
  index: number;
  line: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type TextPageModel = {
  text: string;
  chars: TextCharBox[];
  lines: TextLine[];
};

type AssistantDraft = {
  mode: "translate" | "ask";
  text: string;
  page: number;
  question: string;
  status: "idle" | "loading" | "done" | "error";
  result: string;
  provider: "local" | "cloud" | null;
  error: string;
  notice?: string;
};

type LeftPanelView = "thumbnails" | "search" | "ai";

type TranslatorInstance = {
  translate: (text: string) => Promise<string>;
  destroy?: () => void;
};

type BrowserTranslatorConstructor = {
  create?: (options: { sourceLanguage?: string; targetLanguage: string }) => Promise<TranslatorInstance>;
  availability?: (options: { sourceLanguage?: string; targetLanguage: string }) => Promise<string>;
};

type SearchPage = {
  page: number;
  text: string;
};

type SearchResult = {
  page: number;
  snippet: string;
};

type PageSizeMap = Record<number, { width: number; height: number }>;
type PageCanvasCache = Map<string, HTMLCanvasElement>;
type ZoomAnchor = { page: number; xRatio: number; yRatio: number };
type DocumentSaveDraft = Omit<DocumentSaveData, "version" | "updatedAt">;
type AppShellStyle = CSSProperties & {
  "--app-scale": string;
  "--app-width": string;
  "--app-height": string;
};

function getAppMetrics() {
  if (!window.pdfReadingStorage) {
    return {
      scale: 1,
      width: window.innerWidth,
      height: window.innerHeight
    };
  }

  const widthRatio = window.innerWidth / desktopReferenceSize.width;
  const heightRatio = window.innerHeight / desktopReferenceSize.height;
  const scale = Math.min(1, Math.max(0.68, Math.min(widthRatio, heightRatio)));
  return {
    scale,
    width: window.innerWidth / scale,
    height: window.innerHeight / scale
  };
}

const cloudProviderPresets: Record<CloudProvider, { label: string; baseUrl: string; model: string; envKey: string }> = {
  gpt: {
    label: "GPT",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    envKey: "VITE_OPENAI_API_KEY"
  },
  gemini: {
    label: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    envKey: "VITE_GEMINI_API_KEY"
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    envKey: "VITE_DEEPSEEK_API_KEY"
  }
};

function createAssistantDraft(mode: AssistantDraft["mode"], text: string, page: number): AssistantDraft {
  return {
    mode,
    text,
    page,
    question: "",
    status: "idle",
    result: "",
    provider: null,
    error: ""
  };
}

function getProviderApiKey(settings: AssistantSettings) {
  const preset = cloudProviderPresets[settings.cloudProvider];
  const env = import.meta.env as Record<string, string | undefined>;
  return settings.apiKey.trim() || env[preset.envKey]?.trim() || "";
}

function getBrowserTranslator() {
  const host = window as Window & { Translator?: BrowserTranslatorConstructor };
  return host.Translator;
}

async function runLocalTranslation(text: string, sourceLanguage: string, targetLanguage: string) {
  if (window.pdfReadingTranslator) {
    return window.pdfReadingTranslator.translate({ text, sourceLanguage, targetLanguage });
  }

  const translatorApi = getBrowserTranslator();
  if (!translatorApi?.create) {
    throw new Error("当前环境没有可用的本地翻译能力。");
  }

  const translator = await translatorApi.create({ sourceLanguage, targetLanguage });
  try {
    return await translator.translate(text);
  } finally {
    translator.destroy?.();
  }
}

function getChatCompletionText(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return "";
  const first = choices[0];
  if (typeof first !== "object" || first === null) return "";
  const message = (first as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content.trim() : "";
}

async function runCloudAssistant(draft: AssistantDraft, settings: AssistantSettings) {
  const preset = cloudProviderPresets[settings.cloudProvider];
  const apiKey = getProviderApiKey(settings);
  if (!apiKey) throw new Error(`${preset.label} 还没有配置密钥。`);
  const baseUrl = preset.baseUrl.replace(/\/+$/, "");

  const system =
    draft.mode === "translate"
      ? `You translate academic writing into clear ${settings.targetLanguage === "zh" ? "Simplified Chinese" : settings.targetLanguage}. Keep technical terms accurate and preserve equations, citations, and variable names.`
      : "You help read academic papers. Answer based only on the selected passage. If the passage is insufficient, say what is missing.";
  const user =
    draft.mode === "translate"
      ? draft.text
      : `Selected passage from page ${draft.page}:\n${draft.text}\n\nQuestion:\n${draft.question.trim()}`;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: preset.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.2
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `云端请求失败：${response.status}`);
  }

  const text = getChatCompletionText(await response.json());
  if (!text) throw new Error("云端返回为空。");
  return text;
}

function getVisibleSheetPages(reading: ReadingState) {
  if (reading.flowMode === "scroll" && reading.spreadMode === "double") {
    const leftPage = reading.currentPage % 2 === 0 ? reading.currentPage - 1 : reading.currentPage;
    return [leftPage, leftPage + 1].filter((page) => page >= 1 && page <= reading.pageCount);
  }

  if (reading.spreadMode === "double") {
    return [reading.currentPage, reading.currentPage + 1].filter((page) => page <= reading.pageCount);
  }

  return [reading.currentPage];
}

function getVisibleAnnotationPages(reading: ReadingState) {
  if (reading.spreadMode === "double") {
    return [reading.currentPage, reading.currentPage + 1].filter((page) => page <= reading.pageCount);
  }
  return [reading.currentPage];
}

function buildTextPageModel(
  textContent: { items: Array<unknown> },
  viewport: pdfjsLib.PageViewport
): TextPageModel {
  const lineBuckets = new Map<number, TextCharBox[]>();

  textContent.items.forEach((item) => {
    if (!isTextItem(item)) return;
    const text = item.str;
    if (!text.trim()) return;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const left = tx[4];
    const top = tx[5];
    const width = Math.abs(item.width * viewport.scale);
    const height = Math.max(Math.abs(item.height * viewport.scale), Math.hypot(tx[2], tx[3]), 8 * viewport.scale);
    const lineStep = Math.max(4, height * 0.35);
    const key = Math.round(top / lineStep) * lineStep;
    const bucket = lineBuckets.get(key) ?? [];
    const chars = Array.from(text);
    const weights = chars.map(getTextCharWeight);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
    let cursor = left;
    chars.forEach((char, offset) => {
      const charWidth = width * (weights[offset] / totalWeight);
      bucket.push({
        char,
        index: -1,
        line: -1,
        x: cursor,
        y: top - height,
        width: charWidth,
        height
      });
      cursor += charWidth;
    });
    lineBuckets.set(key, bucket);
  });

  let fullText = "";
  const chars: TextCharBox[] = [];
  const lines = Array.from(lineBuckets.entries())
    .sort(([topA], [topB]) => topA - topB)
    .map(([top, items], lineIndex) => {
      const sorted = items.sort((left, right) => left.x - right.x);
      const start = fullText.length;
      const normalized = insertTextGapSpaces(sorted);
      normalized.forEach((item) => {
        const indexed = { ...item, index: fullText.length, line: lineIndex };
        chars.push(indexed);
        fullText += item.char;
      });
      const end = fullText.length;
      fullText += "\n";
      return {
        text: normalized.map((item) => item.char).join("").replace(/\s+/g, " ").trim(),
        top: Math.min(...normalized.map((item) => item.y)),
        bottom: Math.max(...normalized.map((item) => item.y + item.height)),
        left: Math.min(...normalized.map((item) => item.x)),
        right: Math.max(...normalized.map((item) => item.x + item.width)),
        start,
        end,
        line: lineIndex
      };
    })
    .filter((line) => line.text);

  return {
    text: fullText.trimEnd(),
    chars,
    lines
  };
}

function getTextCharWeight(char: string) {
  if (/\s/.test(char)) return 0.42;
  if (/[ilI1|.,:;!'"`]/.test(char)) return 0.46;
  if (/[mwMW@%&]/.test(char)) return 1.38;
  if (/[\u4e00-\u9fff]/.test(char)) return 1.05;
  if (/[A-Z]/.test(char)) return 1.08;
  return 1;
}

function insertTextGapSpaces(chars: TextCharBox[]) {
  if (chars.length < 2) return chars;
  const widths = chars.filter((char) => char.char.trim()).map((char) => char.width);
  const averageWidth = widths.reduce((sum, width) => sum + width, 0) / Math.max(widths.length, 1);
  const result: TextCharBox[] = [];

  chars.forEach((char) => {
    const previous = result[result.length - 1];
    if (previous && previous.char.trim() && char.char.trim()) {
      const gap = char.x - (previous.x + previous.width);
      if (gap > averageWidth * 0.55) {
        result.push({
          char: " ",
          index: -1,
          line: -1,
          x: previous.x + previous.width,
          y: previous.y,
          width: gap,
          height: previous.height
        });
      }
    }
    result.push(char);
  });

  return result;
}

function isTextItem(item: unknown): item is { str: string; transform: number[]; width: number; height: number } {
  return (
    typeof item === "object" &&
    item !== null &&
    "str" in item &&
    "transform" in item &&
    "width" in item &&
    "height" in item &&
    typeof (item as { str: unknown }).str === "string" &&
    Array.isArray((item as { transform: unknown }).transform) &&
    typeof (item as { width: unknown }).width === "number" &&
    typeof (item as { height: unknown }).height === "number"
  );
}

function repairSelectionText(selection: TextSelectionState, lines: TextLine[] | undefined) {
  const selected = selection.text.replace(/\s+/g, " ").trim();
  if (!selected || !lines?.length) return selection.text;

  const selectedLower = selected.toLowerCase();
  const candidate = lines.find((line) => {
    const lineLower = line.text.toLowerCase();
    return lineLower.startsWith(selectedLower) || lineLower.includes(selectedLower);
  });

  if (!candidate) return selection.text;

  const lineLower = candidate.text.toLowerCase();
  const start = lineLower.indexOf(selectedLower);
  if (start < 0) return selection.text;

  const remainder = candidate.text.slice(start + selected.length);
  if (!remainder || remainder.length > 24) return selection.text;
  if (/^\s*[.;,:)\]\}，。；：、]/.test(remainder) || selected.length / candidate.text.length > 0.72) {
    return candidate.text.slice(start, start + selected.length + remainder.length).trim();
  }

  return selection.text;
}

function hitTestTextChar(model: TextPageModel | null, point: { x: number; y: number }) {
  if (!model?.chars.length) return null;
  const pageAverageHeight =
    model.chars.reduce((sum, char) => sum + char.height, 0) / Math.max(model.chars.length, 1);
  const candidates = model.lines
    .filter((candidate) => point.y >= candidate.top - pageAverageHeight * 0.35 && point.y <= candidate.bottom + pageAverageHeight * 0.45)
    .sort((left, right) => Math.abs(point.y - (left.top + left.bottom) / 2) - Math.abs(point.y - (right.top + right.bottom) / 2));
  const line =
    candidates[0] ??
    model.lines
      .map((candidate) => ({
        line: candidate,
        distance: Math.abs(point.y - (candidate.top + candidate.bottom) / 2)
      }))
      .filter((candidate) => candidate.distance <= pageAverageHeight * 1.2)
      .sort((left, right) => left.distance - right.distance)[0]?.line;
  if (!line) return null;

  const chars = model.chars.filter((char) => char.line === line.line);
  if (!chars.length) return null;
  const sorted = chars.sort((left, right) => left.x - right.x);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (point.x <= first.x) return first.index;
  if (point.x >= last.x + last.width) return last.index + 1;

  const directHit = sorted.find((char) => point.x >= char.x && point.x <= char.x + char.width);
  if (directHit) return point.x > directHit.x + directHit.width / 2 ? directHit.index + 1 : directHit.index;

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const current = sorted[index];
    const next = sorted[index + 1];
    if (point.x > current.x + current.width && point.x < next.x) {
      const middle = (current.x + current.width + next.x) / 2;
      return point.x < middle ? current.index + 1 : next.index;
    }
  }

  return last.index + 1;
}

function buildCustomTextSelection(
  model: TextPageModel | null,
  startIndex: number,
  endIndex: number,
  pageSize: { width: number; height: number }
) {
  if (!model) return null;
  const range = snapTextSelectionRange(model.text, Math.min(startIndex, endIndex), Math.max(startIndex, endIndex));
  const start = range.start;
  const end = range.end;
  if (end <= start) return null;

  const selectedChars = model.chars.filter((char) => char.index >= start && char.index < end && char.char.trim());
  if (!selectedChars.length) return null;

  const rects = Array.from(new Set(selectedChars.map((char) => char.line))).map((line) => {
    const lineChars = selectedChars.filter((char) => char.line === line);
    const left = Math.min(...lineChars.map((char) => char.x));
    const right = Math.max(...lineChars.map((char) => char.x + char.width));
    const top = Math.min(...lineChars.map((char) => char.y));
    const bottom = Math.max(...lineChars.map((char) => char.y + char.height));
    const verticalPadding = Math.max(2, (bottom - top) * 0.14);
    const horizontalPadding = Math.max(1, (bottom - top) * 0.04);
    return {
      x: Math.max(0, left - horizontalPadding) / pageSize.width,
      y: Math.max(0, top - verticalPadding) / pageSize.height,
      width: (Math.min(pageSize.width, right + horizontalPadding) - Math.max(0, left - horizontalPadding)) / pageSize.width,
      height: (Math.min(pageSize.height, bottom + verticalPadding) - Math.max(0, top - verticalPadding)) / pageSize.height
    };
  });

  const firstRect = rects[0];
  const text = model.text.slice(start, end).replace(/\s+\n/g, "\n").trim();
  if (!text) return null;
  return {
    text,
    rects,
    toolbarPoint: {
      left: pageSize.width * (firstRect.x + firstRect.width / 2),
      top: pageSize.height * firstRect.y
    }
  };
}

function snapTextSelectionRange(text: string, rawStart: number, rawEnd: number) {
  let start = Math.max(0, rawStart);
  let end = Math.min(text.length, rawEnd);
  const prefixTrimmed = trimAccidentalLeadingWordTail(text, start, end);
  start = prefixTrimmed.start;
  end = prefixTrimmed.end;
  const selected = text.slice(start, end);
  const trimmed = selected.trim();
  const isSingleWordSelection = Boolean(trimmed) && !/[\s\n]/.test(trimmed);
  if (isSingleWordSelection) return { start, end };

  return { start, end };
}

function trimAccidentalLeadingWordTail(text: string, start: number, end: number) {
  const selected = text.slice(start, end);
  const match = selected.match(/^([\p{L}\p{N}_-]{1,2})(\s+)([\p{L}\p{N}_-]{2,})(?=$|[^\p{L}\p{N}_-])/u);
  if (!match) return { start, end };
  const beforeStart = text[start - 1];
  if (beforeStart && isTextWordChar(beforeStart)) {
    return { start: start + match[1].length + match[2].length, end };
  }
  return { start, end };
}

function isTextWordChar(char: string | undefined) {
  return Boolean(char && /[\p{L}\p{N}_-]/u.test(char));
}

function isSheetVisible(sheet: PaperSheetNote, visiblePages: number[]) {
  return visiblePages.includes(sheet.page);
}

function sameSheetPage(left: PaperSheetNote, right: PaperSheetNote) {
  return left.page === right.page;
}

function sheetPageLabel(sheet: PaperSheetNote) {
  return `第 ${sheet.page} 页`;
}

function pageCacheKey(pageNumber: number, reading: ReadingState) {
  return `${pageNumber}:${reading.scale}:${reading.rotation}`;
}

function pageRenderCacheKey(pageNumber: number, scale: number, rotation: number) {
  return `${pageNumber}:${scale}:${rotation}`;
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function warmPageCanvasCache(
  pdf: PdfDocument,
  pageNumber: number,
  scale: number,
  rotation: number,
  pageCanvasCache: PageCanvasCache,
  isCancelled: () => boolean
) {
  const key = pageRenderCacheKey(pageNumber, scale, rotation);
  if (pageCanvasCache.has(key)) return;

  pdf.getPage(pageNumber)
    .then((page) => {
      if (isCancelled() || pageCanvasCache.has(key)) return;
      const viewport = page.getViewport({ scale, rotation });
      const pixelRatio = window.devicePixelRatio || 1;
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) return;

      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

      page.render({ canvasContext: context, viewport }).promise
        .then(() => {
          if (!isCancelled()) pageCanvasCache.set(key, canvas);
        })
        .catch(() => undefined);
    })
    .catch(() => undefined);
}

export function App() {
  const [paper, setPaper] = useState<PaperSource | null>(null);
  const [paperKey, setPaperKey] = useState<string | null>(null);
  const [pdf, setPdf] = useState<PdfDocument | null>(null);
  const [reading, setReading] = useState<ReadingState>(initialReadingState);
  const [activePage, setActivePage] = useState(1);
  const [pageDraft, setPageDraft] = useState("1");
  const [pageSizes, setPageSizes] = useState<PageSizeMap>({});
  const [textModelsByPage, setTextModelsByPage] = useState<Record<number, TextPageModel>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appMetrics, setAppMetrics] = useState(getAppMetrics);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [leftPanelView, setLeftPanelView] = useState<LeftPanelView>("thumbnails");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchPages, setSearchPages] = useState<SearchPage[]>([]);
  const [isSearchIndexing, setIsSearchIndexing] = useState(false);
  const [viewPanelOpen, setViewPanelOpen] = useState(false);
  const [tool, setTool] = useState<AnnotationTool>(defaultTool);
  const [annotations, setAnnotations] = useState<PaperAnnotation[]>([]);
  const [sheetNotes, setSheetNotes] = useState<PaperSheetNote[]>([]);
  const [activeSheetId, setActiveSheetId] = useState<string | null>(null);
  const [sheetTrayOpen, setSheetTrayOpen] = useState(false);
  const [textSelection, setTextSelection] = useState<TextSelectionState | null>(null);
  const [assistantDraft, setAssistantDraft] = useState<AssistantDraft | null>(null);
  const [assistantSettings, setAssistantSettings] = useState<AssistantSettings>(() => storage.loadAssistantSettings());
  const [savedReading, setSavedReading] = useState<DocumentSaveData["reading"] | null>(null);
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [pendingAnnotationId, setPendingAnnotationId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const currentFileRef = useRef<File | null>(null);
  const noteRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const viewMenuRef = useRef<HTMLDivElement | null>(null);
  const pageCanvasCacheRef = useRef<PageCanvasCache>(new Map());
  const zoomAnchorRef = useRef<ZoomAnchor | null>(null);
  const hasShownLocalTranslationNoticeRef = useRef(false);
  const saveSnapshotRef = useRef<DocumentSaveDraft | null>(null);

  const saveDocumentNow = useCallback(() => {
    const snapshot = saveSnapshotRef.current;
    if (snapshot) storage.saveDocument(snapshot);
  }, []);

  const currentAnnotations = useMemo(
    () => annotations.filter((annotation) => annotation.page === activePage),
    [activePage, annotations]
  );
  const currentNotes = useMemo(
    () =>
      currentAnnotations
        .filter((annotation) => annotation.hasNote)
        .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()),
    [currentAnnotations]
  );

  useEffect(() => {
    setPageDraft(String(reading.currentPage));
  }, [reading.currentPage]);

  useEffect(() => {
    storage.saveAssistantSettings(assistantSettings);
  }, [assistantSettings]);
  const currentSheetNotes = useMemo(
    () => sheetNotes.filter((sheet) => isSheetVisible(sheet, getVisibleSheetPages(reading))),
    [reading, sheetNotes]
  );
  const visibleSheetPages = useMemo(() => getVisibleSheetPages(reading), [reading]);
  const visibleAnnotationPages = useMemo(() => getVisibleAnnotationPages(reading), [reading]);
  const annotationCountByPage = useMemo(
    () =>
      visibleAnnotationPages.map((page) => ({
        page,
        count: annotations.filter((annotation) => annotation.page === page && annotation.hasNote).length
      })),
    [annotations, visibleAnnotationPages]
  );

  useEffect(() => {
    if (!window.pdfReadingStorage) return;

    const updateScale = () => setAppMetrics(getAppMetrics());
    updateScale();
    window.addEventListener("resize", updateScale);
    return () => window.removeEventListener("resize", updateScale);
  }, []);
  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];

    return searchPages.flatMap<SearchResult>((page) => {
      const haystack = page.text.toLowerCase();
      const index = haystack.indexOf(query);
      if (index < 0) return [];

      const start = Math.max(0, index - 42);
      const end = Math.min(page.text.length, index + query.length + 70);
      const prefix = start > 0 ? "..." : "";
      const suffix = end < page.text.length ? "..." : "";
      return [{ page: page.page, snippet: `${prefix}${page.text.slice(start, end)}${suffix}` }];
    });
  }, [searchPages, searchQuery]);
  const activeSheet = useMemo(
    () => sheetNotes.find((sheet) => sheet.id === activeSheetId) ?? null,
    [activeSheetId, sheetNotes]
  );

  useEffect(() => {
    window.pdfReadingApp?.ready();
  }, []);

  useEffect(() => {
    if (!sheetTrayOpen || !activeSheetId) return;
    if (currentSheetNotes.some((sheet) => sheet.id === activeSheetId)) return;
    setActiveSheetId(currentSheetNotes[0]?.id ?? null);
  }, [activeSheetId, currentSheetNotes, sheetTrayOpen]);

  const openFile = useCallback((file: File) => {
    saveDocumentNow();

    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setError("请选择 PDF 文件。");
      return;
    }

    const nextPaperKey = getPaperKey(file);
    const savedDocument = storage.loadDocument(nextPaperKey);
    currentFileRef.current = file;

    setError(null);
    setIsLoading(true);
    setPdf(null);
    setPageSizes({});
    pageCanvasCacheRef.current.clear();
    setTextModelsByPage({});
    setPaperKey(nextPaperKey);
    setSearchPages([]);
    setSearchQuery("");
    setLeftPanelView("thumbnails");
    setAnnotations(
      savedDocument.annotations.map((annotation) => ({
        ...annotation,
        hasNote: annotation.hasNote ?? annotation.note.trim().length > 0
      }))
    );
    setSheetNotes(savedDocument.sheetNotes);
    setSavedReading(savedDocument.reading ?? null);
    setActiveSheetId(null);
    setSheetTrayOpen(false);
    setActiveAnnotationId(null);
    setPendingAnnotationId(null);
    setReading(initialReadingState);

    setPaper((previous) => {
      if (previous) URL.revokeObjectURL(previous.objectUrl);
      return {
        id: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        openedAt: new Date().toISOString(),
        objectUrl: URL.createObjectURL(file)
      };
    });
  }, [saveDocumentNow]);

  useEffect(() => {
    if (!paper) return;

    let isCancelled = false;
    const loadingTask = pdfjsLib.getDocument(paper.objectUrl);

    loadingTask.promise
      .then((document) => {
        if (isCancelled) {
          document.destroy();
          return;
        }
        setPdf(document);
        setReading((state) => {
          const restored = savedReading;
          const currentPage = Math.min(Math.max(restored?.currentPage ?? 1, 1), document.numPages);
          return {
            ...state,
            currentPage,
            pageCount: document.numPages,
            scale: restored?.scale ?? state.scale,
            rotation: restored?.rotation ?? state.rotation,
            spreadMode: restored?.spreadMode ?? state.spreadMode,
            flowMode: restored?.flowMode ?? state.flowMode
          };
        });
        setActivePage(Math.min(Math.max(savedReading?.currentPage ?? 1, 1), document.numPages));
      })
      .catch(() => {
        if (!isCancelled) setError("PDF 加载失败，请换一个文件试试。");
      })
      .finally(() => {
        if (!isCancelled) setIsLoading(false);
      });

    return () => {
      isCancelled = true;
      loadingTask.destroy();
    };
  }, [paper, savedReading]);

  useEffect(() => {
    if (!pdf) return;

    let isCancelled = false;
    const preferredPages = getVisiblePages(reading);
    const pageNumbers = [
      ...preferredPages,
      ...Array.from({ length: pdf.numPages }, (_, index) => index + 1).filter((page) => !preferredPages.includes(page))
    ];

    const loadSizes = async () => {
      for (let index = 0; index < pageNumbers.length; index += 1) {
        const pageNumber = pageNumbers[index];
        try {
          const page = await pdf.getPage(pageNumber);
          if (isCancelled) return;
          const viewport = page.getViewport({ scale: 1, rotation: reading.rotation });
          setPageSizes((sizes) => ({
            ...sizes,
            [pageNumber]: { width: viewport.width * reading.scale, height: viewport.height * reading.scale }
          }));
        } catch {
          // Individual page size failures should not block the rest of the document.
        }

        if (index > 0 && index % 4 === 0) await nextFrame();
      }
    };

    loadSizes();

    return () => {
      isCancelled = true;
    };
  }, [pdf, reading.rotation, reading.spreadMode]);

  useEffect(() => {
    if (!pdf || leftPanelView !== "search") return;

    let isCancelled = false;
    setIsSearchIndexing(true);
    setSearchPages([]);

    const buildSearchIndex = async () => {
      const pages: SearchPage[] = [];

      for (let index = 0; index < pdf.numPages; index += 1) {
        const pageNumber = index + 1;
        try {
          const page = await pdf.getPage(pageNumber);
          const textContent = await page.getTextContent();
          const text = textContent.items
            .map((item) => ("str" in item ? item.str : ""))
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();

          pages.push({ page: pageNumber, text });
          if (!isCancelled && (pageNumber === 1 || pageNumber % 8 === 0)) {
            setSearchPages([...pages]);
          }
        } catch {
          // Keep indexing even if a single page has no readable text.
        }

        if (pageNumber % 4 === 0) await nextFrame();
        if (isCancelled) return;
      }

      if (!isCancelled) {
        setSearchPages(pages);
        setIsSearchIndexing(false);
      }
    };

    buildSearchIndex();

    return () => {
      isCancelled = true;
    };
  }, [leftPanelView, pdf]);

  useEffect(() => {
    if (!paperKey || !pdf) {
      saveSnapshotRef.current = null;
      return;
    }

    saveSnapshotRef.current = {
      paperKey,
      annotations,
      sheetNotes,
      reading: {
        currentPage: reading.currentPage,
        scale: reading.scale,
        rotation: reading.rotation,
        spreadMode: reading.spreadMode,
        flowMode: reading.flowMode
      }
    };

    const saveTimer = window.setTimeout(() => {
      saveDocumentNow();
    }, 300);

    return () => window.clearTimeout(saveTimer);
  }, [
    annotations,
    paperKey,
    pdf,
    reading.currentPage,
    reading.flowMode,
    reading.rotation,
    reading.scale,
    reading.spreadMode,
    saveDocumentNow,
    sheetNotes
  ]);

  useEffect(() => {
    const saveBeforeExit = () => saveDocumentNow();
    const saveWhenHidden = () => {
      if (document.visibilityState === "hidden") saveDocumentNow();
    };

    window.addEventListener("beforeunload", saveBeforeExit);
    window.addEventListener("pagehide", saveBeforeExit);
    document.addEventListener("visibilitychange", saveWhenHidden);

    return () => {
      window.removeEventListener("beforeunload", saveBeforeExit);
      window.removeEventListener("pagehide", saveBeforeExit);
      document.removeEventListener("visibilitychange", saveWhenHidden);
    };
  }, [saveDocumentNow]);

  useEffect(() => {
    return () => {
      if (paper) URL.revokeObjectURL(paper.objectUrl);
    };
  }, [paper]);

  useEffect(() => {
    if (!activeAnnotationId) return;
    noteRefs.current[activeAnnotationId]?.focus();
  }, [activeAnnotationId, currentAnnotations.length]);

  useEffect(() => {
    if (!viewPanelOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!viewMenuRef.current?.contains(event.target as Node)) {
        setViewPanelOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [viewPanelOpen]);

  const pageStep = reading.spreadMode === "double" ? 2 : 1;

  const normalizeDisplayPage = useCallback(
    (page: number, state = reading) => {
      const clamped = Math.min(Math.max(page, 1), Math.max(state.pageCount, 1));
      if (state.flowMode === "paged" && state.spreadMode === "double") {
        return clamped % 2 === 0 ? Math.max(1, clamped - 1) : clamped;
      }
      return clamped;
    },
    [reading]
  );

  const goToPage = (page: number) => {
    const targetPage = Math.min(Math.max(page, 1), Math.max(reading.pageCount, 1));
    setReading((state) => ({
      ...state,
      currentPage: normalizeDisplayPage(page, state)
    }));
    setActivePage(targetPage);
    setActiveAnnotationId(null);
    setPendingAnnotationId(null);
    setActiveSheetId(null);
  };

  const changeScale = (delta: number) => {
    zoomAnchorRef.current = null;
    setReading((state) => {
      const nextScale = Math.min(2.5, Math.max(0.5, Number((state.scale + delta).toFixed(2))));
      const ratio = nextScale / state.scale;
      setPageSizes((sizes) =>
        Object.fromEntries(
          Object.entries(sizes).map(([page, size]) => [
            page,
            { width: size.width * ratio, height: size.height * ratio }
          ])
        )
      );
      return {
        ...state,
        scale: nextScale,
        fitMode: "free"
      };
    });
  };

  const commitPageDraft = () => {
    const value = pageDraft.trim();
    if (!value) {
      setPageDraft(String(reading.currentPage));
      return;
    }

    const targetPage = Number(value);
    if (!Number.isFinite(targetPage)) {
      setPageDraft(String(reading.currentPage));
      return;
    }

    goToPage(targetPage);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditing = target?.tagName === "TEXTAREA" || target?.tagName === "INPUT" || target?.isContentEditable;
      if (isEditing) return;

      if (event.key === "PageDown" || event.key === "ArrowRight") {
        event.preventDefault();
        goToPage(reading.currentPage + pageStep);
      }

      if (event.key === "PageUp" || event.key === "ArrowLeft") {
        event.preventDefault();
        goToPage(reading.currentPage - pageStep);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pageStep, reading.currentPage]);

  const addAnnotation = (page: number, rect: AnnotationRect) => {
    if (!paperKey) return;

    const now = new Date().toISOString();
    const annotation: PaperAnnotation = {
      id: crypto.randomUUID(),
      paperKey,
      page,
      rect,
      color: tool.color,
      style: tool.style,
      hasNote: false,
      note: "",
      createdAt: now,
      updatedAt: now
    };

    setAnnotations((items) => [annotation, ...items]);
    setActiveAnnotationId(null);
    setPendingAnnotationId(annotation.id);
    setActivePage(page);
    setReading((state) => ({ ...state, currentPage: normalizeDisplayPage(page, state) }));
  };

  const createNoteForAnnotation = (id: string) => {
    const target = annotations.find((annotation) => annotation.id === id);
    setAnnotations((items) =>
      items.map((annotation) =>
        annotation.id === id ? { ...annotation, hasNote: true, updatedAt: new Date().toISOString() } : annotation
      )
    );
    if (target) {
      setActivePage(target.page);
      setReading((state) => ({ ...state, currentPage: normalizeDisplayPage(target.page, state) }));
    }
    setRightOpen(true);
    setActiveAnnotationId(id);
    setPendingAnnotationId(null);
  };

  const updateAnnotationNote = (id: string, note: string) => {
    setAnnotations((items) =>
      items.map((annotation) =>
        annotation.id === id ? { ...annotation, note, updatedAt: new Date().toISOString() } : annotation
      )
    );
  };

  const removeAnnotationNote = (id: string) => {
    setAnnotations((items) =>
      items.map((annotation) =>
        annotation.id === id ? { ...annotation, hasNote: false, note: "", updatedAt: new Date().toISOString() } : annotation
      )
    );
    setActiveAnnotationId((activeId) => (activeId === id ? null : activeId));
  };

  const removeAnnotation = (id: string) => {
    setAnnotations((items) => items.filter((annotation) => annotation.id !== id));
    setActiveAnnotationId((activeId) => (activeId === id ? null : activeId));
    setPendingAnnotationId((pendingId) => (pendingId === id ? null : pendingId));
  };

  const runAssistant = useCallback(async () => {
    if (!assistantDraft) return;
    if (assistantDraft.mode === "ask" && !assistantDraft.question.trim()) {
      setAssistantDraft({ ...assistantDraft, status: "error", error: "请先输入问题。", result: "", provider: null });
      return;
    }

    const canUseCloud = assistantSettings.providerMode !== "local" && getProviderApiKey(assistantSettings).length > 0;
    const selectedProvider = cloudProviderPresets[assistantSettings.cloudProvider];
    if (assistantSettings.providerMode === "cloud" && !canUseCloud) {
      setAssistantDraft({
        ...assistantDraft,
        status: "error",
        error: `${selectedProvider.label} 模型不可用：还没有配置密钥。`,
        result: "",
        provider: "cloud"
      });
      return;
    }

    const provider: AssistantDraft["provider"] =
      assistantSettings.providerMode === "local" || !canUseCloud ? "local" : "cloud";
    const shouldShowLocalTranslationNotice =
      provider === "local" && assistantDraft.mode === "translate" && !hasShownLocalTranslationNoticeRef.current;
    if (shouldShowLocalTranslationNotice) hasShownLocalTranslationNoticeRef.current = true;
    setAssistantDraft({
      ...assistantDraft,
      status: "loading",
      error: "",
      result: "",
      provider,
      notice: shouldShowLocalTranslationNotice ? "首次加载本地模型会稍慢。" : ""
    });

    try {
      const result =
        provider === "cloud"
          ? await runCloudAssistant(assistantDraft, assistantSettings)
          : assistantDraft.mode === "translate"
            ? await runLocalTranslation(
                assistantDraft.text,
                assistantSettings.sourceLanguage,
                assistantSettings.targetLanguage
              )
            : await Promise.reject(new Error("提问需要配置云端模型，本地模式暂不支持问答。"));

      setAssistantDraft((current) =>
        current ? { ...current, status: "done", result, error: "", provider, notice: "" } : current
      );
    } catch (errorValue) {
      const message = errorValue instanceof Error ? errorValue.message : "处理失败。";
      if (assistantSettings.providerMode === "auto" && provider === "cloud" && assistantDraft.mode === "translate") {
        try {
          const shouldShowFallbackNotice = !hasShownLocalTranslationNoticeRef.current;
          if (shouldShowFallbackNotice) hasShownLocalTranslationNoticeRef.current = true;
          if (shouldShowFallbackNotice) {
            setAssistantDraft((current) =>
              current ? { ...current, provider: "local", notice: "首次加载本地模型会稍慢。" } : current
            );
          }
          const result = await runLocalTranslation(
            assistantDraft.text,
            assistantSettings.sourceLanguage,
            assistantSettings.targetLanguage
          );
          setAssistantDraft((current) =>
            current ? { ...current, status: "done", result, error: "", provider: "local", notice: "" } : current
          );
          return;
        } catch {
          // Keep the first cloud error visible when both routes fail.
        }
      }

      setAssistantDraft((current) =>
        current ? { ...current, status: "error", result: "", error: message, provider, notice: "" } : current
      );
    }
  }, [assistantDraft, assistantSettings]);

  const selectAnnotation = (id: string) => {
    setActiveAnnotationId(id);
    const annotation = annotations.find((item) => item.id === id);
    if (annotation) setActivePage(annotation.page);
    if (annotation?.hasNote) {
      setRightOpen(true);
      window.setTimeout(() => {
        document.querySelector(`[data-note-id="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 0);
    }
  };

  const insertSheetNote = (page = reading.currentPage) => {
    if (!paperKey) return;

    const now = new Date().toISOString();
    const samePageCount = sheetNotes.filter((sheet) => sheet.page === page).length;
    const sheet: PaperSheetNote = {
      id: crypto.randomUUID(),
      paperKey,
      page,
      title: `第 ${page} 页笔记纸 ${samePageCount + 1}`,
      content: "",
      height: 280,
      createdAt: now,
      updatedAt: now
    };

    setSheetNotes((items) => [sheet, ...items]);
    setActiveSheetId(sheet.id);
    setSheetTrayOpen(true);
  };

  const updateSheetNote = (id: string, patch: Partial<Pick<PaperSheetNote, "title" | "content" | "height">>) => {
    setSheetNotes((items) =>
      items.map((sheet) =>
        sheet.id === id ? { ...sheet, ...patch, updatedAt: new Date().toISOString() } : sheet
      )
    );
  };

  const removeSheetNote = (id: string) => {
    setSheetNotes((items) => {
      const removed = items.find((sheet) => sheet.id === id);
      const nextItems = items.filter((sheet) => sheet.id !== id);

      setActiveSheetId((current) => {
        if (current !== id) return current;
        const nextSamePage = nextItems.find((sheet) => removed && sameSheetPage(sheet, removed));
        const nextId = nextSamePage?.id ?? null;
        if (!nextId) setSheetTrayOpen(true);
        return nextId;
      });

      return nextItems;
    });
  };

  const exportPdf = async () => {
    const file = currentFileRef.current;
    if (!file) return;

    const data = await file.arrayBuffer();
    if (window.pdfReadingFile) {
      await window.pdfReadingFile.savePdf({ defaultName: file.name, data });
      return;
    }

    const url = URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main
      className="app-shell"
      style={
        {
          "--app-scale": appMetrics.scale.toFixed(3),
          "--app-width": `${appMetrics.width}px`,
          "--app-height": `${appMetrics.height}px`
        } as AppShellStyle
      }
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const file = event.dataTransfer.files[0];
        if (file) openFile(file);
      }}
    >
      <header className="top-bar">
        <div className="brand-block">
          <BookOpen size={20} />
          <div>
            <strong>Mutsumi</strong>
            <span>{paper ? paper.name : "本地 PDF 阅读工作台"}</span>
          </div>
          <button className="brand-open-button" title="Open PDF" onClick={() => fileInputRef.current?.click()}>
            <FolderOpen size={17} />
          </button>
        </div>

        <div className="toolbar">
          <button title="导出 PDF" disabled={!paper} onClick={exportPdf}>
            <Download size={18} />
          </button>
          <input
            ref={fileInputRef}
            hidden
            type="file"
            accept="application/pdf,.pdf"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) openFile(file);
              event.currentTarget.value = "";
            }}
          />
          <button title="上一页" disabled={!pdf || reading.currentPage <= 1} onClick={() => goToPage(reading.currentPage - pageStep)}>
            <ChevronLeft size={18} />
          </button>
          <input
            className="page-input"
            aria-label="页码"
            disabled={!pdf}
            value={pageDraft}
            onChange={(event) => setPageDraft(event.target.value.replace(/[^\d]/g, ""))}
            onBlur={commitPageDraft}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.currentTarget.blur();
            }}
          />
          <span className="page-total">/ {reading.pageCount || "-"}</span>
          <button title="下一页" disabled={!pdf || reading.currentPage >= reading.pageCount} onClick={() => goToPage(reading.currentPage + pageStep)}>
            <ChevronRight size={18} />
          </button>
          <button title="缩小" disabled={!pdf} onClick={() => changeScale(-0.1)}>
            <ZoomOut size={18} />
          </button>
          <button title="放大" disabled={!pdf} onClick={() => changeScale(0.1)}>
            <ZoomIn size={18} />
          </button>
          <button title="旋转" disabled={!pdf} onClick={() => setReading((state) => ({ ...state, rotation: (state.rotation + 90) % 360 }))}>
            <RotateCw size={18} />
          </button>
          <div className="view-menu" ref={viewMenuRef}>
            <button
              className={viewPanelOpen ? "active" : ""}
              title="显示方式"
              disabled={!pdf}
              onClick={() => setViewPanelOpen((open) => !open)}
            >
              <Settings2 size={18} />
            </button>
            {viewPanelOpen && (
              <div className="view-popover">
                <div className="view-row">
                  <span>页数</span>
                  <div className="segmented-control">
                    <button
                      className={reading.spreadMode === "single" ? "active" : ""}
                      onClick={() => setReading((state) => ({ ...state, spreadMode: "single" }))}
                    >
                      单页
                    </button>
                    <button
                      className={reading.spreadMode === "double" ? "active" : ""}
                      onClick={() => setReading((state) => ({ ...state, spreadMode: "double" }))}
                    >
                      双页
                    </button>
                  </div>
                </div>
                <div className="view-row">
                  <span>方式</span>
                  <div className="segmented-control">
                    <button
                      className={reading.flowMode === "paged" ? "active" : ""}
                      onClick={() => setReading((state) => ({ ...state, flowMode: "paged" }))}
                    >
                      翻页
                    </button>
                    <button
                      className={reading.flowMode === "scroll" ? "active" : ""}
                      onClick={() => setReading((state) => ({ ...state, flowMode: "scroll" }))}
                    >
                      滚动
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="annotation-toolbar" aria-label="标注工具栏">
          {toolColors.map((color) => (
            <button
              className={`swatch ${tool.color === color ? "active" : ""}`}
              key={color}
              title={`标注颜色 ${color}`}
              style={{ "--swatch": color } as CSSProperties}
              onClick={() => setTool((current) => ({ ...current, color, mode: "annotate" }))}
            />
          ))}
          <ToolButton icon={<Highlighter size={17} />} label="高亮" styleName="highlight" tool={tool} onSelect={(style) => setTool((current) => ({ ...current, style, mode: "annotate" }))} />
          <ToolButton icon={<Underline size={17} />} label="下划线" styleName="underline" tool={tool} onSelect={(style) => setTool((current) => ({ ...current, style, mode: "annotate" }))} />
          <button
            className={tool.mode === "select" ? "active" : ""}
            title="选择"
            onClick={() => setTool((current) => ({ ...current, mode: "select" }))}
          >
            <MousePointer2 size={17} />
          </button>
        </div>
      </header>

      <section className="workspace">
        <aside className={`left-panel ${leftOpen ? "open" : "closed"}`}>
          <button className="panel-toggle" title="切换功能栏" onClick={() => setLeftOpen((value) => !value)}>
            <PanelLeftClose size={18} />
          </button>
          {leftOpen && (
            <div className="panel-content">
              <div className="left-panel-tabs">
                <button
                  className={leftPanelView === "thumbnails" ? "active" : ""}
                  title="缩略图"
                  onClick={() => setLeftPanelView("thumbnails")}
                >
                  <FileText size={16} />
                </button>
                <button
                  className={leftPanelView === "search" ? "active" : ""}
                  title="文内搜索"
                  onClick={() => setLeftPanelView("search")}
                >
                  <Search size={16} />
                </button>
                <button
                  className={leftPanelView === "ai" ? "active" : ""}
                  title="翻译与提问"
                  onClick={() => setLeftPanelView("ai")}
                >
                  <Bot size={16} />
                </button>
              </div>
              {leftPanelView === "thumbnails" ? (
                <ThumbnailPanel
                  activePages={getVisiblePages(reading)}
                  pdf={pdf}
                  pageCount={reading.pageCount}
                  onGoToPage={goToPage}
                />
              ) : leftPanelView === "search" ? (
                <SearchPanel
                  isIndexing={isSearchIndexing}
                  query={searchQuery}
                  results={searchResults}
                  onGoToPage={goToPage}
                  onQueryChange={setSearchQuery}
                />
              ) : (
                <AiPanel
                  assistantDraft={assistantDraft}
                  settings={assistantSettings}
                  onChange={setAssistantDraft}
                  onRun={runAssistant}
                  onSettingsChange={setAssistantSettings}
                />
              )}
            </div>
          )}
        </aside>

        <section
          className={`center-workspace ${leftOpen ? "left-safe" : ""} ${sheetTrayOpen ? "sheet-safe" : ""}`}
          style={
            {
              "--left-safe-area": "24px",
              "--sheet-safe-area": `${(activeSheet?.height ?? 240) + 42}px`
            } as CSSProperties
          }
        >
          <PdfStage
            pdf={pdf}
            reading={reading}
            isLoading={isLoading}
            error={error}
            tool={tool}
            annotations={annotations}
            activeAnnotationId={activeAnnotationId}
            pendingAnnotationId={pendingAnnotationId}
            textSelection={textSelection}
            onOpenFile={() => fileInputRef.current?.click()}
            onCreateAnnotation={addAnnotation}
            onCreateNote={createNoteForAnnotation}
            onDeleteAnnotation={removeAnnotation}
            onSelectAnnotation={selectAnnotation}
            onSetCurrentPage={(page) => setReading((state) => ({ ...state, currentPage: normalizeDisplayPage(page, state) }))}
            onSetActivePage={setActivePage}
            pageSizes={pageSizes}
            pageCanvasCache={pageCanvasCacheRef.current}
            onPageSize={(page, size) =>
              setPageSizes((sizes) =>
                sizes[page]?.width === size.width && sizes[page]?.height === size.height
                  ? sizes
                  : { ...sizes, [page]: size }
              )
            }
            onZoomAnchor={(anchor) => {
              zoomAnchorRef.current = anchor;
            }}
            onTextModel={(page, model) => setTextModelsByPage((items) => ({ ...items, [page]: model }))}
            zoomAnchorRef={zoomAnchorRef}
            onTextSelection={(selection) => {
              setTextSelection(selection);
              setAssistantDraft(null);
            }}
            onClearTextSelection={() => {
              setTextSelection(null);
              setAssistantDraft(null);
            }}
            onClearSelection={() => {
              setPendingAnnotationId(null);
              setActiveAnnotationId(null);
            }}
          />
          {textSelection && (
            <TextSelectionToolbar
              selection={textSelection}
              onCopy={async () => {
                await navigator.clipboard?.writeText(repairSelectionText(textSelection, textModelsByPage[textSelection.page]?.lines));
                setTextSelection(null);
              }}
              onTranslate={() => {
                setAssistantDraft(createAssistantDraft("translate", repairSelectionText(textSelection, textModelsByPage[textSelection.page]?.lines), textSelection.page));
                setLeftOpen(true);
                setLeftPanelView("ai");
                setTextSelection(null);
              }}
              onAsk={() => {
                setAssistantDraft(createAssistantDraft("ask", repairSelectionText(textSelection, textModelsByPage[textSelection.page]?.lines), textSelection.page));
                setLeftOpen(true);
                setLeftPanelView("ai");
                setTextSelection(null);
              }}
            />
          )}
          <SheetNoteTray
            activeSheet={activeSheet}
            pageSheets={currentSheetNotes}
            visiblePages={visibleSheetPages}
            isAvailable={Boolean(pdf)}
            isOpen={sheetTrayOpen}
            onAddSheet={insertSheetNote}
            onSelectSheet={(id) => {
              setActiveSheetId(id);
              setSheetTrayOpen(true);
            }}
            onOpen={() => {
              setSheetTrayOpen(true);
              setActiveSheetId(currentSheetNotes[0]?.id ?? null);
            }}
            onClose={() => {
              setActiveSheetId(null);
              setSheetTrayOpen(false);
            }}
            onRemove={removeSheetNote}
            onUpdate={updateSheetNote}
          />
        </section>

        <aside className={`right-panel ${rightOpen ? "open" : "closed"}`}>
          <button className="panel-toggle" title="切换注释栏" onClick={() => setRightOpen((value) => !value)}>
            <PanelRightClose size={18} />
          </button>
          {rightOpen && (
            <div className="panel-content">
              <div className="panel-heading">
                {visibleAnnotationPages.length > 1 ? (
                  <div className="annotation-page-tabs">
                    {annotationCountByPage.map(({ page, count }) => (
                      <button
                        className={activePage === page ? "active" : ""}
                        key={page}
                        onClick={() => setActivePage(page)}
                      >
                        第 {page} 页 <span>{count}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <>
                    <h2>第 {activePage} 页注释</h2>
                    <span>{currentNotes.length} 条</span>
                  </>
                )}
              </div>
              <div className="note-list">
                {currentNotes.length === 0 ? (
                  <p className="muted">标注后点击右下角小图标，在这里新建注释。</p>
                ) : (
                  currentNotes.map((annotation, index) => (
                    <article
                      className={`note-card ${activeAnnotationId === annotation.id ? "active" : ""}`}
                      data-note-id={annotation.id}
                      key={annotation.id}
                      onClick={() => selectAnnotation(annotation.id)}
                    >
                      <div className="note-card-header">
                        <span className="note-index" style={{ background: annotation.color }}>{index + 1}</span>
                        <strong>{styleLabel(annotation.style)}</strong>
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            removeAnnotationNote(annotation.id);
                          }}
                        >
                          删除注释
                        </button>
                      </div>
                      <AutoResizeTextarea
                        ref={(element) => {
                          noteRefs.current[annotation.id] = element;
                        }}
                        placeholder="像写在纸页旁边一样记录你的理解、疑问或推导"
                        value={annotation.note}
                        onFocus={() => setActiveAnnotationId(null)}
                        onChange={(event) => updateAnnotationNote(annotation.id, event.target.value)}
                      />
                    </article>
                  ))
                )}
              </div>
            </div>
          )}
        </aside>
      </section>
    </main>
  );
}

const AutoResizeTextarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function AutoResizeTextarea({
  value,
  onChange,
  ...props
}, forwardedRef) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const resize = useCallback((element: HTMLTextAreaElement | null) => {
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, []);

  useEffect(() => {
    resize(textareaRef.current);
  }, [resize, value]);

  useImperativeHandle(forwardedRef, () => textareaRef.current as HTMLTextAreaElement);

  return (
    <textarea
      {...props}
      ref={textareaRef}
      value={value}
      onChange={(event) => {
        onChange?.(event);
        resize(event.currentTarget);
      }}
    />
  );
});

function ToolButton({
  icon,
  label,
  styleName,
  tool,
  onSelect
}: {
  icon: ReactNode;
  label: string;
  styleName: AnnotationStyle;
  tool: AnnotationTool;
  onSelect: (style: AnnotationStyle) => void;
}) {
  return (
    <button className={tool.mode === "annotate" && tool.style === styleName ? "active" : ""} title={label} onClick={() => onSelect(styleName)}>
      {icon}
    </button>
  );
}

function styleLabel(style: AnnotationStyle) {
  if (style === "underline") return "下划线";
  return "高亮";
}

function PdfStage({
  pdf,
  reading,
  isLoading,
  error,
  tool,
  annotations,
  activeAnnotationId,
  pendingAnnotationId,
  textSelection,
  onOpenFile,
  onCreateAnnotation,
  onCreateNote,
  onDeleteAnnotation,
  onSelectAnnotation,
  onSetCurrentPage,
  onSetActivePage,
  pageSizes,
  pageCanvasCache,
  onPageSize,
  onZoomAnchor,
  onTextModel,
  zoomAnchorRef,
  onTextSelection,
  onClearTextSelection,
  onClearSelection
}: {
  pdf: PdfDocument | null;
  reading: ReadingState;
  isLoading: boolean;
  error: string | null;
  tool: AnnotationTool;
  annotations: PaperAnnotation[];
  activeAnnotationId: string | null;
  pendingAnnotationId: string | null;
  textSelection: TextSelectionState | null;
  onOpenFile: () => void;
  onCreateAnnotation: (page: number, rect: AnnotationRect) => void;
  onCreateNote: (id: string) => void;
  onDeleteAnnotation: (id: string) => void;
  onSelectAnnotation: (id: string) => void;
  onSetCurrentPage: (page: number) => void;
  onSetActivePage: (page: number) => void;
  pageSizes: PageSizeMap;
  pageCanvasCache: PageCanvasCache;
  onPageSize: (page: number, size: { width: number; height: number }) => void;
  onZoomAnchor: (anchor: ZoomAnchor) => void;
  onTextModel: (page: number, model: TextPageModel) => void;
  zoomAnchorRef: React.MutableRefObject<ZoomAnchor | null>;
  onTextSelection: (selection: TextSelectionState) => void;
  onClearTextSelection: () => void;
  onClearSelection: () => void;
}) {
  const stageRef = useRef<HTMLElement | null>(null);
  const scrollSyncedPageRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const programmaticScrollTargetRef = useRef<number | null>(null);
  const programmaticScrollTimerRef = useRef<number | null>(null);
  const previousFlowModeRef = useRef(reading.flowMode);
  const layoutReady = Object.keys(pageSizes).length >= reading.pageCount;

  useEffect(() => {
    if (!pdf || reading.flowMode !== "paged") return;

    let isCancelled = false;
    const visiblePages = getVisiblePages(reading);
    const preloadPages = Array.from(
      new Set(
        visiblePages.flatMap((page) => [
          page - 2,
          page - 1,
          page,
          page + 1,
          page + 2
        ])
      )
    ).filter((page) => page >= 1 && page <= reading.pageCount);

    preloadPages.forEach((pageNumber) => {
      const key = pageCacheKey(pageNumber, reading);
      if (pageCanvasCache.has(key)) return;

      warmPageCanvasCache(pdf, pageNumber, reading.scale, reading.rotation, pageCanvasCache, () => isCancelled);
    });

    return () => {
      isCancelled = true;
    };
  }, [pageCanvasCache, pdf, reading.currentPage, reading.flowMode, reading.pageCount, reading.rotation, reading.scale, reading.spreadMode]);

  useEffect(() => {
    if (!pdf || reading.flowMode !== "paged") return;

    let isCancelled = false;
    const timeoutId = window.setTimeout(() => {
      const warmScales = [-0.4, -0.3, -0.2, -0.1, 0.1, 0.2]
        .map((delta) => Math.min(2.5, Math.max(0.5, Number((reading.scale + delta).toFixed(2)))))
        .filter((scale, index, items) => scale !== reading.scale && items.indexOf(scale) === index);

      getVisiblePages(reading).forEach((pageNumber) => {
        warmScales.forEach((scale) => {
          warmPageCanvasCache(pdf, pageNumber, scale, reading.rotation, pageCanvasCache, () => isCancelled);
        });
      });
    }, 260);

    return () => {
      isCancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [pageCanvasCache, pdf, reading.currentPage, reading.flowMode, reading.rotation, reading.scale, reading.spreadMode]);

  useLayoutEffect(() => {
    if (!pdf || reading.flowMode !== "scroll") return;
    if (!layoutReady) return;
    if (scrollSyncedPageRef.current === reading.currentPage) {
      scrollSyncedPageRef.current = null;
      return;
    }

    const stage = stageRef.current;
    const pageElement = stage?.querySelector<HTMLElement>(`[data-page-number="${reading.currentPage}"]`);
    if (!stage || !pageElement) return;

    programmaticScrollTargetRef.current = reading.currentPage;
    if (programmaticScrollTimerRef.current) window.clearTimeout(programmaticScrollTimerRef.current);

    const targetPage = reading.currentPage;
    const targetTop = Math.max(0, pageElement.offsetTop - 24);
    stage.scrollTop = targetTop;
    previousFlowModeRef.current = reading.flowMode;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (programmaticScrollTargetRef.current !== targetPage) return;
        const settledStage = stageRef.current;
        const settledElement = settledStage?.querySelector<HTMLElement>(`[data-page-number="${targetPage}"]`);
        if (!settledStage || !settledElement) return;
        settledStage.scrollTop = Math.max(0, settledElement.offsetTop - 24);
      });
    });

    programmaticScrollTimerRef.current = window.setTimeout(() => {
      programmaticScrollTargetRef.current = null;
    }, 520);
  }, [layoutReady, pdf, reading.currentPage, reading.flowMode]);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
      if (programmaticScrollTimerRef.current !== null) window.clearTimeout(programmaticScrollTimerRef.current);
    };
  }, []);

  if (!pdf) {
    return (
      <section className="reader-stage empty-stage">
        <div className="drop-target">
          <FileText size={42} />
          <h1>打开一篇 PDF 开始阅读</h1>
          <p>支持拖拽到窗口，也可以从本地选择文件。文件只在本地处理。</p>
          <button className="primary-action" onClick={onOpenFile}>
            选择 PDF
          </button>
          {isLoading && <span className="muted">正在加载...</span>}
          {error && <span className="error-text">{error}</span>}
        </div>
      </section>
    );
  }

  const pageNumbers = getVisiblePages(reading);
  const renderWindowPages = getRenderWindowPages(reading);

  const syncScrollPage = () => {
    if (reading.flowMode !== "scroll" || !stageRef.current) return;
    if (!layoutReady) return;
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);

    scrollFrameRef.current = requestAnimationFrame(() => {
      if (!stageRef.current) return;
      if (programmaticScrollTargetRef.current !== null) {
        return;
      }

      const stageRect = stageRef.current.getBoundingClientRect();
      const pageElements = Array.from(stageRef.current.querySelectorAll<HTMLElement>("[data-page-number]"));
      const anchorY = stageRect.top + 32;
      const nearest = pageElements.reduce<{ page: number; distance: number } | null>((best, element) => {
        const page = Number(element.dataset.pageNumber);
        const distance = Math.abs(element.getBoundingClientRect().top - anchorY);
        if (!best || distance < best.distance) return { page, distance };
        return best;
      }, null);

      if (nearest && nearest.page !== reading.currentPage) {
        scrollSyncedPageRef.current = nearest.page;
        onSetCurrentPage(nearest.page);
        onSetActivePage(nearest.page);
      }
    });
  };

  return (
    <section className={`reader-stage ${reading.flowMode} ${reading.spreadMode}`} ref={stageRef} onScroll={syncScrollPage}>
      <div className="pages-wrap">
        {pageNumbers.map((pageNumber) => (
          renderWindowPages.includes(pageNumber) ? (
            <PdfPageView
              key={pageNumber}
              pdf={pdf}
              pageNumber={pageNumber}
              reading={reading}
              initialPageSize={pageSizes[pageNumber]}
              pageCanvasCache={pageCanvasCache}
              tool={tool}
              annotations={annotations.filter((annotation) => annotation.page === pageNumber)}
              noteOrder={annotations
                .filter((item) => item.page === pageNumber && item.hasNote)
                .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())}
              activeAnnotationId={activeAnnotationId}
              pendingAnnotationId={pendingAnnotationId}
              textSelection={textSelection?.page === pageNumber ? textSelection : null}
              onCreateAnnotation={onCreateAnnotation}
              onCreateNote={onCreateNote}
              onDeleteAnnotation={onDeleteAnnotation}
              onPageSize={onPageSize}
              onTextModel={onTextModel}
              onSelectAnnotation={(id) => {
                onSetCurrentPage(pageNumber);
                onSetActivePage(pageNumber);
                onSelectAnnotation(id);
              }}
              onTextSelection={onTextSelection}
              onClearTextSelection={onClearTextSelection}
              onClearSelection={onClearSelection}
            />
          ) : (
            <PagePlaceholder
              key={pageNumber}
              pageNumber={pageNumber}
              pageSize={pageSizes[pageNumber]}
              reading={reading}
            />
          )
        ))}
      </div>
      {error && <span className="error-text">{error}</span>}
    </section>
  );
}

function getVisiblePages(reading: ReadingState) {
  if (reading.flowMode === "scroll") {
    return Array.from({ length: reading.pageCount }, (_, index) => index + 1);
  }

  if (reading.spreadMode === "double") {
    return [reading.currentPage, reading.currentPage + 1].filter((page) => page <= reading.pageCount);
  }

  return [reading.currentPage];
}

function getRenderWindowPages(reading: ReadingState) {
  if (reading.flowMode !== "scroll") return getVisiblePages(reading);

  const radius = reading.spreadMode === "double" ? 4 : 3;
  const start = Math.max(1, reading.currentPage - radius);
  const end = Math.min(reading.pageCount, reading.currentPage + radius);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function getFallbackPageSize(reading: ReadingState) {
  return {
    width: (reading.rotation % 180 === 0 ? 690 : 890) * reading.scale,
    height: (reading.rotation % 180 === 0 ? 890 : 690) * reading.scale
  };
}

function PagePlaceholder({
  pageNumber,
  pageSize,
  reading
}: {
  pageNumber: number;
  pageSize: { width: number; height: number } | undefined;
  reading: ReadingState;
}) {
  const fallbackSize = getFallbackPageSize(reading);
  const width = pageSize?.width ?? fallbackSize.width;
  const height = pageSize?.height ?? fallbackSize.height;

  return (
    <div className="page-placeholder" data-page-number={pageNumber} style={{ width, height }}>
      <span>第 {pageNumber} 页</span>
    </div>
  );
}

function PdfPageView({
  pdf,
  pageNumber,
  reading,
  initialPageSize,
  pageCanvasCache,
  tool,
  annotations,
  noteOrder,
  activeAnnotationId,
  pendingAnnotationId,
  textSelection,
  onCreateAnnotation,
  onCreateNote,
  onDeleteAnnotation,
  onPageSize,
  onTextModel,
  onSelectAnnotation,
  onTextSelection,
  onClearTextSelection,
  onClearSelection
}: {
  pdf: PdfDocument;
  pageNumber: number;
  reading: ReadingState;
  initialPageSize: { width: number; height: number } | undefined;
  pageCanvasCache: PageCanvasCache;
  tool: AnnotationTool;
  annotations: PaperAnnotation[];
  noteOrder: PaperAnnotation[];
  activeAnnotationId: string | null;
  pendingAnnotationId: string | null;
  textSelection: TextSelectionState | null;
  onCreateAnnotation: (page: number, rect: AnnotationRect) => void;
  onCreateNote: (id: string) => void;
  onDeleteAnnotation: (id: string) => void;
  onPageSize: (page: number, size: { width: number; height: number }) => void;
  onTextModel: (page: number, model: TextPageModel) => void;
  onSelectAnnotation: (id: string) => void;
  onTextSelection: (selection: TextSelectionState) => void;
  onClearTextSelection: () => void;
  onClearSelection: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const [pageSize, setPageSize] = useState(initialPageSize ?? getFallbackPageSize(reading));
  const [draftRect, setDraftRect] = useState<AnnotationRect | null>(null);
  const [textModel, setTextModel] = useState<TextPageModel | null>(null);
  const [textSelectionDraft, setTextSelectionDraft] = useState<{ start: number; end: number } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const textDragStartRef = useRef<number | null>(null);
  const textDragEndRef = useRef<number | null>(null);
  const scaleRef = useRef(reading.scale);
  const rotationRef = useRef(reading.rotation);

  useLayoutEffect(() => {
    setPageSize((current) => {
      if (rotationRef.current !== reading.rotation) {
        return initialPageSize ?? getFallbackPageSize(reading);
      }
      const ratio = reading.scale / scaleRef.current;
      return { width: current.width * ratio, height: current.height * ratio };
    });
    scaleRef.current = reading.scale;
    rotationRef.current = reading.rotation;
  }, [initialPageSize, reading.rotation, reading.scale]);

  useEffect(() => {
    if (!canvasRef.current || !textLayerRef.current) return;

    let isCancelled = false;
    let renderTask: pdfjsLib.RenderTask | null = null;
    let textLayer: pdfjsLib.TextLayer | null = null;
    let renderTimer: number | null = null;
    const key = pageCacheKey(pageNumber, reading);
    const cachedCanvas = pageCanvasCache.get(key);

    if (cachedCanvas) {
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      if (context) {
        canvas.width = cachedCanvas.width;
        canvas.height = cachedCanvas.height;
        canvas.style.width = cachedCanvas.style.width;
        canvas.style.height = cachedCanvas.style.height;
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(cachedCanvas, 0, 0);
      }
    }

    const renderPage = () => pdf.getPage(pageNumber).then((page) => {
      if (isCancelled || !canvasRef.current || !textLayerRef.current) return;

      const viewport = page.getViewport({ scale: reading.scale, rotation: reading.rotation });
      const canvas = canvasRef.current;
      const textLayerContainer = textLayerRef.current;
      const context = canvas.getContext("2d");
      if (!context) return;

      const pixelRatio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      setPageSize({ width: viewport.width, height: viewport.height });
      onPageSize(pageNumber, { width: viewport.width, height: viewport.height });
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

      renderTask = page.render({ canvasContext: context, viewport });
      renderTask.promise
        .then(() => {
          if (isCancelled) return;
          const cached = document.createElement("canvas");
          const cacheContext = cached.getContext("2d");
          if (!cacheContext) return;
          cached.width = canvas.width;
          cached.height = canvas.height;
          cached.style.width = canvas.style.width;
          cached.style.height = canvas.style.height;
          cacheContext.drawImage(canvas, 0, 0);
          pageCanvasCache.set(key, cached);
        })
        .catch(() => undefined);

      textLayerContainer.replaceChildren();
      textLayer = new pdfjsLib.TextLayer({
        textContentSource: page.streamTextContent(),
        container: textLayerContainer,
        viewport
      });
      textLayer.render().catch(() => undefined);

      page.getTextContent().then((textContent) => {
        if (!isCancelled) {
          const model = buildTextPageModel(textContent, viewport);
          setTextModel(model);
          onTextModel(pageNumber, model);
        }
      }).catch(() => undefined);
    });

    const delay = reading.flowMode === "scroll" ? Math.min(Math.abs(pageNumber - reading.currentPage) * 45, 450) : 0;
    renderTimer = window.setTimeout(() => {
      renderPage().catch(() => undefined);
    }, delay);

    return () => {
      isCancelled = true;
      if (renderTimer !== null) window.clearTimeout(renderTimer);
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [pageCanvasCache, pdf, pageNumber, reading.flowMode, reading.rotation, reading.scale]);

  const getPoint = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const scaleX = bounds.width ? pageSize.width / bounds.width : 1;
    const scaleY = bounds.height ? pageSize.height / bounds.height : 1;
    return {
      x: Math.min(Math.max((event.clientX - bounds.left) * scaleX, 0), pageSize.width),
      y: Math.min(Math.max((event.clientY - bounds.top) * scaleY, 0), pageSize.height)
    };
  };

  const normalizeRect = (start: { x: number; y: number }, end: { x: number; y: number }) => ({
    x: Math.min(start.x, end.x) / pageSize.width,
    y: Math.min(start.y, end.y) / pageSize.height,
    width: Math.abs(end.x - start.x) / pageSize.width,
    height: Math.abs(end.y - start.y) / pageSize.height
  });

  return (
    <div
      className="page-layer"
      data-page-number={pageNumber}
      style={{ width: pageSize.width, height: pageSize.height, "--text-hit-slop": `${Math.min(0.02 + reading.scale * 0.018, 0.065)}em` } as CSSProperties}
      onPointerDown={(event) => {
        if (!pageSize.width || event.button !== 0) return;
        onClearSelection();
        if (tool.mode === "select") return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragStartRef.current = getPoint(event);
        setDraftRect({ x: dragStartRef.current.x / pageSize.width, y: dragStartRef.current.y / pageSize.height, width: 0, height: 0 });
      }}
      onPointerMove={(event) => {
        if (tool.mode === "select") return;
        if (!dragStartRef.current) return;
        setDraftRect(normalizeRect(dragStartRef.current, getPoint(event)));
      }}
      onPointerUp={(event) => {
        if (tool.mode === "select") return;
        if (!dragStartRef.current) return;
        const rect = normalizeRect(dragStartRef.current, getPoint(event));
        dragStartRef.current = null;
        setDraftRect(null);
        if (rect.width > 0.01 && rect.height > 0.006) onCreateAnnotation(pageNumber, rect);
      }}
    >
      <canvas ref={canvasRef} />
      <div
        className={`textLayer text-layer ${tool.mode === "select" ? "selectable" : ""}`}
        ref={textLayerRef}
        onPointerDown={(event) => {
          if (tool.mode !== "select") return;
          event.preventDefault();
          event.stopPropagation();
          const start = hitTestTextChar(textModel, getPoint(event));
          if (start === null) {
            onClearTextSelection();
            return;
          }
          event.currentTarget.setPointerCapture(event.pointerId);
          textDragStartRef.current = start;
          textDragEndRef.current = start;
          setTextSelectionDraft({ start, end: start });
          onClearTextSelection();
        }}
        onPointerMove={(event) => {
          if (tool.mode !== "select" || textDragStartRef.current === null) return;
          event.preventDefault();
          const end = hitTestTextChar(textModel, getPoint(event));
          if (end !== null) {
            textDragEndRef.current = end;
            setTextSelectionDraft({ start: textDragStartRef.current, end });
          }
        }}
        onPointerUp={(event) => {
          if (tool.mode !== "select" || textDragStartRef.current === null) return;
          event.preventDefault();
          event.stopPropagation();
          const end = hitTestTextChar(textModel, getPoint(event)) ?? textDragEndRef.current;
          const selection = end === null ? null : buildCustomTextSelection(textModel, textDragStartRef.current, end, pageSize);
          textDragStartRef.current = null;
          textDragEndRef.current = null;
          setTextSelectionDraft(null);
          if (!selection) {
            onClearTextSelection();
            return;
          }
          const bounds = event.currentTarget.getBoundingClientRect();
          onTextSelection({
            text: selection.text,
            page: pageNumber,
            rects: selection.rects,
            position: {
              left: bounds.left + selection.toolbarPoint.left,
              top: Math.max(8, bounds.top + selection.toolbarPoint.top - 42)
            }
          });
        }}
      />
      {tool.mode === "select" && textSelectionDraft && (
        <div className="custom-text-selection-layer">
          {buildCustomTextSelection(textModel, textSelectionDraft.start, textSelectionDraft.end, pageSize)?.rects.map((rect, index) => (
            <div className="custom-text-selection" key={index} style={rectToStyle(rect, pageSize)} />
          ))}
        </div>
      )}
      {tool.mode === "select" && !textSelectionDraft && textSelection?.rects?.length ? (
        <div className="custom-text-selection-layer">
          {textSelection.rects.map((rect, index) => (
            <div className="custom-text-selection settled" key={index} style={rectToStyle(rect, pageSize)} />
          ))}
        </div>
      ) : null}
      <div className="annotation-layer">
        {annotations.map((annotation) => {
          const noteIndex = noteOrder.findIndex((item) => item.id === annotation.id) + 1;
          return (
            <button
              className={`annotation-mark ${annotation.style} ${activeAnnotationId === annotation.id ? "active" : ""}`}
              key={annotation.id}
              style={markStyle(annotation, pageSize)}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onSelectAnnotation(annotation.id);
              }}
              title={annotation.hasNote ? `对应右侧第 ${noteIndex} 条注释` : "未添加注释的标注"}
            >
              {annotation.hasNote && <span style={noteBadgeStyle(pageSize)}>{noteIndex}</span>}
            </button>
          );
        })}
        {pendingAnnotationId && annotations.some((annotation) => annotation.id === pendingAnnotationId && !annotation.hasNote) && (
          <button
            className="add-note-bubble"
            style={bubbleStyle(annotations.find((annotation) => annotation.id === pendingAnnotationId), pageSize)}
            title="添加注释"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onCreateNote(pendingAnnotationId);
            }}
          >
            <MessageSquarePlus size={15} />
          </button>
        )}
        {activeAnnotationId && annotations.some((annotation) => annotation.id === activeAnnotationId) && (
          <div
            className="annotation-action-popover"
            style={popoverStyle(annotations.find((annotation) => annotation.id === activeAnnotationId), pageSize)}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <button title="添加或打开注释" onClick={() => onCreateNote(activeAnnotationId)}>
              <MessageSquarePlus size={15} />
              注释
            </button>
            <button className="danger" title="删除标注" onClick={() => onDeleteAnnotation(activeAnnotationId)}>
              <Trash2 size={15} />
              删除
            </button>
          </div>
        )}
        {draftRect && <div className="annotation-draft" style={rectToStyle(draftRect, pageSize)} />}
      </div>
    </div>
  );
}

function SheetNoteTray({
  activeSheet,
  pageSheets,
  visiblePages,
  isAvailable,
  isOpen,
  onAddSheet,
  onSelectSheet,
  onOpen,
  onClose,
  onRemove,
  onUpdate
}: {
  activeSheet: PaperSheetNote | null;
  pageSheets: PaperSheetNote[];
  visiblePages: number[];
  isAvailable: boolean;
  isOpen: boolean;
  onAddSheet: (page?: number) => void;
  onSelectSheet: (id: string) => void;
  onOpen: () => void;
  onClose: () => void;
  onRemove: (id: string) => void;
  onUpdate: (id: string, patch: Partial<Pick<PaperSheetNote, "title" | "content" | "height">>) => void;
}) {
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) setAddMenuOpen(false);
  }, [isOpen]);

  const handleAdd = () => {
    if (visiblePages.length <= 1) {
      onAddSheet(visiblePages[0]);
      return;
    }
    setAddMenuOpen((open) => !open);
  };

  const chooseAddPage = (page: number) => {
    onAddSheet(page);
    setAddMenuOpen(false);
  };

  if (!isOpen) {
    return (
      <button className="sheet-float-button" title="打开笔记纸" disabled={!isAvailable} onClick={onOpen}>
        <NotebookPen size={19} />
        <span>{pageSheets.length}</span>
      </button>
    );
  }

  if (!activeSheet) {
    return (
      <aside className="sheet-tray empty-sheet-tray" style={{ height: 240 }}>
        <div className="sheet-header">
          <div className="sheet-empty-title">当前页笔记纸</div>
          <div className="sheet-actions">
            <AddSheetButton addMenuOpen={addMenuOpen} onAdd={handleAdd} onChoosePage={chooseAddPage} visiblePages={visiblePages} />
            <button title="收起笔记纸" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="sheet-empty-state">
          <NotebookPen size={24} />
          <p>还没有笔记纸。点击添加，记录推导、代码或公式。</p>
        </div>
      </aside>
    );
  }

  return (
    <aside className="sheet-tray" style={{ height: activeSheet.height }}>
      <button
        className="sheet-resizer"
        title="拖拽调整笔记纸高度"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          resizeRef.current = { startY: event.clientY, startHeight: activeSheet.height };
        }}
        onPointerMove={(event) => {
          if (!resizeRef.current) return;
          const nextHeight = resizeRef.current.startHeight + resizeRef.current.startY - event.clientY;
          onUpdate(activeSheet.id, { height: Math.min(Math.max(nextHeight, 180), 560) });
        }}
        onPointerUp={() => {
          resizeRef.current = null;
        }}
      >
        <GripHorizontal size={18} />
      </button>

      <div className="sheet-header">
        <div className="sheet-tabs">
          {pageSheets.map((sheet) => (
            <button
              className={sheet.id === activeSheet.id ? "active" : ""}
              key={sheet.id}
              onClick={() => onSelectSheet(sheet.id)}
            >
              <span>{sheetPageLabel(sheet)}</span>
              {sheet.title}
            </button>
          ))}
        </div>
        <div className="sheet-actions">
          <AddSheetButton addMenuOpen={addMenuOpen} onAdd={handleAdd} onChoosePage={chooseAddPage} visiblePages={visiblePages} />
          <button title="删除笔记纸" onClick={() => onRemove(activeSheet.id)}>
            删除
          </button>
          <button title="收起笔记纸" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="sheet-body">
        <section className="sheet-editor">
          <input
            className="sheet-title-input"
            value={activeSheet.title}
            onChange={(event) => onUpdate(activeSheet.id, { title: event.target.value })}
          />
          <textarea
            value={activeSheet.content}
            onChange={(event) => onUpdate(activeSheet.id, { content: event.target.value })}
            spellCheck={false}
          />
        </section>
        <section className="sheet-preview">{renderRichNote(activeSheet.content)}</section>
      </div>
    </aside>
  );
}

function TextSelectionToolbar({
  selection,
  onCopy,
  onTranslate,
  onAsk
}: {
  selection: TextSelectionState;
  onCopy: () => void;
  onTranslate: () => void;
  onAsk: () => void;
}) {
  return (
    <div className="selection-toolbar" style={{ left: selection.position.left, top: selection.position.top }}>
      <div className="selection-actions">
        <button title="复制" onClick={onCopy}>
          <Clipboard size={14} />
          复制
        </button>
        <button title="翻译" onClick={onTranslate}>
          <Languages size={14} />
          翻译
        </button>
        <button title="提问" onClick={onAsk}>
          <Bot size={14} />
          提问
        </button>
      </div>
    </div>
  );
}

function AiPanel({
  assistantDraft,
  settings,
  onChange,
  onRun,
  onSettingsChange
}: {
  assistantDraft: AssistantDraft | null;
  settings: AssistantSettings;
  onChange: (draft: AssistantDraft | null) => void;
  onRun: () => void;
  onSettingsChange: (settings: AssistantSettings) => void;
}) {
  if (!assistantDraft) {
    return (
      <div className="ai-panel empty">
        <Bot size={24} />
        <p>选中文本后点击翻译或提问，这里会显示上下文。</p>
      </div>
    );
  }

  const setMode = (mode: AssistantDraft["mode"]) =>
    onChange({ ...assistantDraft, mode, status: "idle", result: "", error: "", provider: null });
  const runDisabled = assistantDraft.status === "loading" || (assistantDraft.mode === "ask" && !assistantDraft.question.trim());
  const showCloudSettings = settings.providerMode !== "local";
  const selectedProvider = cloudProviderPresets[settings.cloudProvider];

  return (
    <div className="ai-panel">
      <div className="ai-source">
        <span>来源：第 {assistantDraft.page} 页</span>
        <blockquote>{assistantDraft.text}</blockquote>
      </div>
      <div className="ai-mode-switch">
        <button className={assistantDraft.mode === "translate" ? "active" : ""} onClick={() => setMode("translate")}>
          翻译
        </button>
        <button className={assistantDraft.mode === "ask" ? "active" : ""} onClick={() => setMode("ask")}>
          提问
        </button>
      </div>
      {assistantDraft.mode === "ask" && (
        <textarea
          className="ai-question-input"
          placeholder="输入你想追问的问题"
          value={assistantDraft.question}
          onChange={(event) => onChange({ ...assistantDraft, question: event.target.value })}
        />
      )}
      <section className="ai-settings">
        <label>
          <span>模式</span>
          <select
            value={settings.providerMode}
            onChange={(event) => onSettingsChange({ ...settings, providerMode: event.target.value as AssistantSettings["providerMode"] })}
          >
            <option value="auto">自动</option>
            <option value="cloud">云端</option>
            <option value="local">本地</option>
          </select>
        </label>
        {showCloudSettings && (
          <label>
            <span>模型</span>
            <select
              value={settings.cloudProvider}
              onChange={(event) => onSettingsChange({ ...settings, cloudProvider: event.target.value as CloudProvider })}
            >
              {Object.entries(cloudProviderPresets).map(([provider, preset]) => (
                <option key={provider} value={provider}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>
      <button className="ai-run-button" disabled={runDisabled} onClick={onRun}>
        {assistantDraft.status === "loading" ? "处理中..." : assistantDraft.mode === "translate" ? "翻译" : "提问"}
      </button>
      <div className={"ai-result-placeholder " + assistantDraft.status}>
        <strong>
          {assistantDraft.mode === "translate" ? "翻译结果" : "回答"}
          {assistantDraft.provider ? " / " + (assistantDraft.provider === "cloud" ? "云端" : "本地") : ""}
        </strong>
        {assistantDraft.notice ? <p className="ai-notice">{assistantDraft.notice}</p> : null}
        {assistantDraft.status === "error" ? (
          <p>{assistantDraft.error}</p>
        ) : assistantDraft.result ? (
          <pre>{assistantDraft.result}</pre>
        ) : (
          <p>
            {assistantDraft.mode === "translate"
              ? "自动模式会优先使用 " + selectedProvider.label + "；没有配置密钥时尝试本地翻译。"
              : "提问需要已配置的 " + selectedProvider.label + " 云端模型。"}
          </p>
        )}
      </div>
    </div>
  );
}

function ThumbnailPanel({
  activePages,
  pdf,
  pageCount,
  onGoToPage
}: {
  activePages: number[];
  pdf: PdfDocument | null;
  pageCount: number;
  onGoToPage: (page: number) => void;
}) {
  if (!pdf || pageCount === 0) {
    return <p className="muted">打开 PDF 后显示页面缩略图。</p>;
  }

  return (
    <div className="thumbnail-list">
      {Array.from({ length: pageCount }, (_, index) => index + 1).map((pageNumber) => (
        <button
          className={`thumbnail-item ${activePages.includes(pageNumber) ? "active" : ""}`}
          key={pageNumber}
          onClick={() => onGoToPage(pageNumber)}
        >
          <PdfThumbnail pdf={pdf} pageNumber={pageNumber} />
          <span>第 {pageNumber} 页</span>
        </button>
      ))}
    </div>
  );
}

function PdfThumbnail({ pdf, pageNumber }: { pdf: PdfDocument; pageNumber: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;

    let isCancelled = false;
    let renderTask: pdfjsLib.RenderTask | null = null;

    pdf.getPage(pageNumber).then((page) => {
      if (isCancelled || !canvasRef.current) return;

      const baseViewport = page.getViewport({ scale: 1 });
      const scale = 118 / baseViewport.width;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      if (!context) return;

      const pixelRatio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

      renderTask = page.render({ canvasContext: context, viewport });
      renderTask.promise.catch(() => undefined);
    });

    return () => {
      isCancelled = true;
      renderTask?.cancel();
    };
  }, [pageNumber, pdf]);

  return <canvas ref={canvasRef} />;
}

function SearchPanel({
  isIndexing,
  query,
  results,
  onGoToPage,
  onQueryChange
}: {
  isIndexing: boolean;
  query: string;
  results: SearchResult[];
  onGoToPage: (page: number) => void;
  onQueryChange: (query: string) => void;
}) {
  return (
    <div className="search-panel">
      <input
        placeholder="搜索文本"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      <div className="search-status">
        {isIndexing ? "正在建立搜索索引..." : query.trim() ? `${results.length} 个结果` : "输入关键词开始搜索"}
      </div>
      <div className="search-results">
        {results.map((result, index) => (
          <button key={`${result.page}-${index}`} onClick={() => onGoToPage(result.page)}>
            <strong>第 {result.page} 页</strong>
            <span>{result.snippet}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function AddSheetButton({
  addMenuOpen,
  visiblePages,
  onAdd,
  onChoosePage
}: {
  addMenuOpen: boolean;
  visiblePages: number[];
  onAdd: () => void;
  onChoosePage: (page: number) => void;
}) {
  return (
    <div className="sheet-add-menu">
      <button title="添加笔记纸" onClick={onAdd}>
        添加
      </button>
      {addMenuOpen && visiblePages.length > 1 && (
        <div className="sheet-add-popover">
          {visiblePages.map((page) => (
            <button key={page} onClick={() => onChoosePage(page)}>
              第 {page} 页
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function renderRichNote(content: string) {
  const blocks: ReactNode[] = [];
  const lines = content.split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      blocks.push(
        <pre className="note-code" key={`code-${index}`}>
          {language && <span>{language}</span>}
          <code>{code.join("\n")}</code>
        </pre>
      );
    } else if (line.trim() === "$$") {
      const formula: string[] = [];
      index += 1;
      while (index < lines.length && lines[index].trim() !== "$$") {
        formula.push(lines[index]);
        index += 1;
      }
      blocks.push(
        <div className="note-formula" key={`formula-${index}`}>
          {formula.join("\n")}
        </div>
      );
    } else if (line.startsWith("## ")) {
      blocks.push(<h3 key={`h-${index}`}>{line.slice(3)}</h3>);
    } else if (line.trim()) {
      blocks.push(<p key={`p-${index}`}>{renderInlineMath(line)}</p>);
    } else {
      blocks.push(<br key={`br-${index}`} />);
    }

    index += 1;
  }

  return blocks;
}

function renderInlineMath(line: string) {
  const parts = line.split(/(\$[^$]+\$)/g);
  return parts.map((part, index) => {
    if (part.startsWith("$") && part.endsWith("$")) {
      return (
        <span className="inline-formula" key={`${part}-${index}`}>
          {part.slice(1, -1)}
        </span>
      );
    }
    return part;
  });
}

function bubbleStyle(annotation: PaperAnnotation | undefined, pageSize: { width: number; height: number }) {
  if (!annotation) return { display: "none" };

  const rect = rectToStyle(annotation.rect, pageSize);
  return {
    left: Math.min(Number(rect.left) + Number(rect.width) + 6, pageSize.width - 34),
    top: Math.min(Number(rect.top) + Number(rect.height) + 6, pageSize.height - 34)
  };
}

function popoverStyle(annotation: PaperAnnotation | undefined, pageSize: { width: number; height: number }) {
  if (!annotation) return { display: "none" };

  const rect = rectToStyle(annotation.rect, pageSize);
  return {
    left: Math.min(Number(rect.left) + Number(rect.width) + 8, pageSize.width - 150),
    top: Math.max(Number(rect.top) - 8, 8)
  };
}

function noteBadgeStyle(pageSize: { width: number; height: number }) {
  const scale = Math.min(Math.max(pageSize.width / 720, 0.65), 1);
  const size = 14 * scale;

  return {
    minWidth: size,
    height: size,
    top: -7 * scale,
    right: -7 * scale,
    fontSize: 9 * scale
  } as CSSProperties;
}

function rectToStyle(rect: AnnotationRect, pageSize: { width: number; height: number }) {
  return {
    left: rect.x * pageSize.width,
    top: rect.y * pageSize.height,
    width: rect.width * pageSize.width,
    height: rect.height * pageSize.height
  };
}

function markStyle(annotation: PaperAnnotation, pageSize: { width: number; height: number }) {
  return {
    ...rectToStyle(annotation.rect, pageSize),
    "--mark-color": annotation.color
  } as CSSProperties;
}
