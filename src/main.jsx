import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as pdfjsLib from "pdfjs-dist";
import "./styles.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url
).toString();

const SHORTCUT_LABEL = navigator.platform.toLowerCase().includes("mac")
  ? "Cmd+K"
  : "Ctrl+K";
const BASE_SCALE = 1.35;
const MIN_ZOOM = 0.7;
const MAX_ZOOM = 2.4;
const ZOOM_STEP = 0.1;
const SPACE_WIDTH_RATIO = 0.34;

function App() {
  const [fileName, setFileName] = useState("");
  const [pdf, setPdf] = useState(null);
  const [status, setStatus] = useState("Choose one PDF to begin.");
  const [zoom, setZoom] = useState(1);
  const [renderZoom, setRenderZoom] = useState(1);
  const [selection, setSelection] = useState(null);
  const [selectionHint, setSelectionHint] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [isAsking, setIsAsking] = useState(false);
  const [error, setError] = useState("");
  const [answerPanel, setAnswerPanel] = useState(null);
  const [panelFitZoom, setPanelFitZoom] = useState(null);
  const [paragraphOverview, setParagraphOverview] = useState(null);
  const promptRef = useRef(null);
  const readerShellRef = useRef(null);
  const paragraphRequestIdRef = useRef(0);
  const zoomProgress = ((zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM)) * 100;
  const effectiveZoom = answerPanel && panelFitZoom ? Math.min(zoom, panelFitZoom) : zoom;

  const clearPromptState = useCallback(() => {
    setSelection(null);
    setSelectionHint(null);
    setPrompt("");
  }, []);

  const readSelection = useCallback(() => {
    const activeSelection = window.getSelection();
    const selectedText = getCleanSelectedText(activeSelection);

    if (!activeSelection?.rangeCount || !selectedText) {
      return null;
    }

    const range = activeSelection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return null;

    return {
      text: selectedText,
      top: Math.max(16, rect.top + window.scrollY - 12),
      left: Math.min(
        window.scrollX + rect.left,
        window.scrollX + document.documentElement.clientWidth - 380
      )
    };
  }, []);

  const openAskBox = useCallback(() => {
    const nextSelection = readSelection();
    if (!nextSelection) return;

    setSelection(nextSelection);
    setSelectionHint(null);
    setPrompt("");
    setError("");
  }, [readSelection]);

  const updateSelectionHint = useCallback(() => {
    window.setTimeout(() => {
      if (selection) return;
      setSelectionHint(readSelection());
    }, 0);
  }, [readSelection, selection]);

  useEffect(() => {
    function onKeyDown(event) {
      const isShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (event.key === "Escape") {
        clearPromptState();
        return;
      }

      if (!isShortcut) return;

      event.preventDefault();
      openAskBox();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearPromptState, openAskBox]);

  useEffect(() => {
    function hideSelectionHint() {
      setSelectionHint(null);
    }

    window.addEventListener("mouseup", updateSelectionHint);
    window.addEventListener("keyup", updateSelectionHint);
    window.addEventListener("scroll", hideSelectionHint, true);

    return () => {
      window.removeEventListener("mouseup", updateSelectionHint);
      window.removeEventListener("keyup", updateSelectionHint);
      window.removeEventListener("scroll", hideSelectionHint, true);
    };
  }, [updateSelectionHint]);

  useEffect(() => {
    if (selection) {
      requestAnimationFrame(() => promptRef.current?.focus());
    }
  }, [selection]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setRenderZoom(effectiveZoom);
    }, 110);

    return () => window.clearTimeout(timeoutId);
  }, [effectiveZoom]);

  useEffect(() => {
    if (!answerPanel || !pdf) {
      setPanelFitZoom(null);
      return undefined;
    }

    let cancelled = false;

    async function updateFitZoom() {
      const shell = readerShellRef.current;
      if (!shell) return;

      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: BASE_SCALE });
      const availableWidth = shell.clientWidth - 56;
      const nextFitZoom = Math.min(
        zoom,
        Math.max(MIN_ZOOM, availableWidth / viewport.width)
      );

      if (!cancelled) {
        setPanelFitZoom(Number(nextFitZoom.toFixed(2)));
      }
    }

    updateFitZoom();
    window.addEventListener("resize", updateFitZoom);

    return () => {
      cancelled = true;
      window.removeEventListener("resize", updateFitZoom);
    };
  }, [answerPanel, pdf, zoom]);

  useEffect(() => {
    function onParagraphButtonClick(event) {
      const button = event.target.closest(".paragraphButton");
      if (!button) return;

      event.preventDefault();
      event.stopPropagation();
      openParagraphOverview(button);
    }

    document.addEventListener("click", onParagraphButtonClick);
    return () => document.removeEventListener("click", onParagraphButtonClick);
  }, []);

  async function onFileChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setError("Please choose a PDF file.");
      return;
    }

    setFileName(file.name);
    setPdf(null);
    setZoom(1);
    setRenderZoom(1);
    clearPromptState();
    setError("");
    setStatus("Loading PDF...");

    try {
      const data = await file.arrayBuffer();
      const loaded = await pdfjsLib.getDocument({ data }).promise;
      setPdf(loaded);
      setStatus(`${loaded.numPages} page${loaded.numPages === 1 ? "" : "s"} loaded.`);
    } catch (loadError) {
      console.error(loadError);
      setStatus("Choose one PDF to begin.");
      setError("That PDF could not be loaded.");
    }
  }

  function changeZoom(nextZoom) {
    const boundedZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
    setZoom(Number(boundedZoom.toFixed(2)));
    clearPromptState();
    window.getSelection()?.removeAllRanges();
  }

  async function submitQuestion(event) {
    event.preventDefault();
    if (!selection?.text || !prompt.trim()) return;

    const selectedText = selection.text;
    const question = prompt.trim();

    setIsAsking(true);
    setError("");
    setAnswerPanel({
      selection: selectedText,
      prompt: question,
      answer: "",
      error: "",
      isLoading: true,
      isStreaming: false
    });
    setSelection(null);
    setSelectionHint(null);
    setPrompt("");
    window.getSelection()?.removeAllRanges();

    try {
      const response = await fetch("/api/ask/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selection: selectedText,
          prompt: question
        })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "The model request failed.");
      }

      await readAnswerStream(response);
    } catch (askError) {
      const message = askError instanceof Error ? askError.message : "The model request failed.";
      setAnswerPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              error: message,
              isLoading: false,
              isStreaming: false
            }
          : currentPanel
      );
    } finally {
      setIsAsking(false);
    }
  }

  return (
    <main className={answerPanel ? "hasAnswerPanel" : ""}>
      <header className="topbar">
        <div>
          <h1>PDF Web Reader</h1>
          <p>{fileName || status}</p>
        </div>
        <div className="topbarControls">
          {pdf ? (
            <div
              className="zoomControls"
              style={{ "--zoom-progress": `${zoomProgress}%` }}
              aria-label="Zoom controls"
            >
              <button
                type="button"
                title="Zoom out"
                aria-label="Zoom out"
                onClick={() => changeZoom(zoom - ZOOM_STEP)}
              >
                -
              </button>
              <input
                aria-label="Zoom level"
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={ZOOM_STEP}
                value={zoom}
                onChange={(event) => changeZoom(Number(event.target.value))}
              />
              <button
                type="button"
                title="Zoom in"
                aria-label="Zoom in"
                onClick={() => changeZoom(zoom + ZOOM_STEP)}
              >
                +
              </button>
              <button
                type="button"
                className="zoomValue"
                title="Reset zoom"
                aria-label="Reset zoom"
                onClick={() => changeZoom(1)}
              >
                {Math.round(zoom * 100)}%
              </button>
            </div>
          ) : null}
          <label className="filePicker">
            <span>Open PDF</span>
            <input type="file" accept="application/pdf" onChange={onFileChange} />
          </label>
        </div>
      </header>

      <section className="readerShell" ref={readerShellRef} aria-label="PDF reader">
        {!pdf ? (
          <div className="emptyState">
            <strong>Select a PDF</strong>
            <span>Highlight text in the document, then press {SHORTCUT_LABEL} to ask about it.</span>
          </div>
        ) : (
          <PdfDocument pdf={pdf} zoom={effectiveZoom} renderZoom={renderZoom} />
        )}
      </section>

      {selectionHint ? (
        <button
          type="button"
          className="selectionHint"
          style={{ top: selectionHint.top, left: Math.max(16, selectionHint.left) }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={openAskBox}
        >
          Press {SHORTCUT_LABEL} to ask
        </button>
      ) : null}

      {selection ? (
        <aside
          className="askBox"
          style={{ top: selection.top, left: Math.max(16, selection.left) }}
          aria-label="Ask about highlighted text"
        >
          <form onSubmit={submitQuestion}>
            <div className="selectedText">{selection.text}</div>
            <textarea
              ref={promptRef}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                if (event.shiftKey) return;
                if (event.nativeEvent.isComposing) return;

                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }}
              placeholder="Ask about this highlight..."
              rows={3}
            />
            <div className="askActions">
              <button type="button" onClick={clearPromptState}>
                Close
              </button>
              <button type="submit" disabled={isAsking || !prompt.trim()}>
                {isAsking ? "Asking..." : "Ask"}
              </button>
            </div>
          </form>
          {error ? <div className="error">{error}</div> : null}
        </aside>
      ) : null}

      {answerPanel ? (
        <AnswerPanel
          panel={answerPanel}
          onClose={() => setAnswerPanel(null)}
        />
      ) : null}

      {paragraphOverview ? (
        <ParagraphOverview
          overview={paragraphOverview}
          onClose={() => setParagraphOverview(null)}
        />
      ) : null}
    </main>
  );

  async function openParagraphOverview(button) {
    const paragraphText = normalizePdfSelectionText(button.dataset.paragraph || "");
    if (!paragraphText) return;

    const requestId = paragraphRequestIdRef.current + 1;
    paragraphRequestIdRef.current = requestId;

    const rect = button.getBoundingClientRect();
    const top = window.scrollY + rect.top - 6;
    const left = Math.min(
      window.scrollX + rect.right + 10,
      window.scrollX + document.documentElement.clientWidth - 390
    );

    setParagraphOverview({
      text: paragraphText,
      answer: "",
      error: "",
      isLoading: true,
      top: Math.max(16, top),
      left: Math.max(16, left)
    });

    try {
      const response = await fetch("/api/ask/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selection: paragraphText,
          prompt:
            "Give a simplified overview of this paragraph. Explain the main idea in plain language, clarify important notation or terms, and keep it focused for readability."
        })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "The paragraph overview failed.");
      }

      await readParagraphOverviewStream({ response, requestId });
    } catch (overviewError) {
      const message =
        overviewError instanceof Error
          ? overviewError.message
          : "The paragraph overview failed.";

      if (paragraphRequestIdRef.current === requestId) {
        setParagraphOverview((currentOverview) =>
          currentOverview
            ? {
                ...currentOverview,
                error: message,
                isLoading: false
              }
            : currentOverview
        );
      }
    }
  }

  async function readParagraphOverviewStream({ response, requestId }) {
    if (!response.body) throw new Error("The model stream was empty.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const eventText of events) {
        applyParagraphEvent({ event: parseStreamEvent(eventText), requestId });
      }
    }

    if (buffer.trim()) {
      applyParagraphEvent({ event: parseStreamEvent(buffer), requestId });
    }

    if (paragraphRequestIdRef.current === requestId) {
      setParagraphOverview((currentOverview) =>
        currentOverview
          ? {
              ...currentOverview,
              isLoading: false
            }
          : currentOverview
      );
    }
  }

  function applyParagraphEvent({ event, requestId }) {
    if (!event || paragraphRequestIdRef.current !== requestId) return;

    if (event.type === "message") {
      setParagraphOverview((currentOverview) =>
        currentOverview
          ? {
              ...currentOverview,
              answer: `${currentOverview.answer}${event.data.token || ""}`,
              isLoading: false
            }
          : currentOverview
      );
    }

    if (event.type === "error") {
      setParagraphOverview((currentOverview) =>
        currentOverview
          ? {
              ...currentOverview,
              error: event.data.error || "The paragraph overview failed.",
              isLoading: false
            }
          : currentOverview
      );
    }
  }

  async function readAnswerStream(response) {
    if (!response.body) {
      throw new Error("The model stream was empty.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const eventText of events) {
        applyStreamEvent(parseStreamEvent(eventText));
      }
    }

    if (buffer.trim()) {
      applyStreamEvent(parseStreamEvent(buffer));
    }

    setAnswerPanel((currentPanel) =>
      currentPanel
        ? {
            ...currentPanel,
            isLoading: false,
            isStreaming: false
          }
        : currentPanel
    );
  }

  function applyStreamEvent(event) {
    if (!event) return;

    if (event.type === "message") {
      setAnswerPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              answer: `${currentPanel.answer}${event.data.token || ""}`,
              isLoading: false,
              isStreaming: true
            }
          : currentPanel
      );
      return;
    }

    if (event.type === "status") {
      setAnswerPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              isLoading: event.data.mode === "loading",
              isStreaming: false
            }
          : currentPanel
      );
      return;
    }

    if (event.type === "error") {
      setAnswerPanel((currentPanel) =>
        currentPanel
          ? {
              ...currentPanel,
              error: event.data.error || "The model request failed.",
              isLoading: false,
              isStreaming: false
            }
          : currentPanel
      );
    }
  }
}

function parseStreamEvent(eventText) {
  const lines = eventText.split("\n");
  const type = lines
    .find((line) => line.startsWith("event:"))
    ?.slice(6)
    .trim();
  const dataLine = lines.find((line) => line.startsWith("data:"));

  if (!type || !dataLine) return null;

  try {
    return {
      type,
      data: JSON.parse(dataLine.slice(5).trim())
    };
  } catch {
    return null;
  }
}

function AnswerPanel({ panel, onClose }) {
  return (
    <aside className="answerPanel" aria-label="Model explanation">
      <div className="answerPanelHeader">
        <div>
          <span>Explanation</span>
          <strong>{panel.prompt}</strong>
        </div>
        <button type="button" onClick={onClose} aria-label="Close explanation">
          x
        </button>
      </div>
      <div className="answerPanelBody">
        <section>
          <h2>Highlight</h2>
          <p className="panelSelection">{panel.selection}</p>
        </section>
        <section>
          <h2>Answer</h2>
          {panel.isLoading && !panel.answer ? (
            <div className="loadingState" role="status" aria-live="polite">
              <span className="spinner" />
              <span>Thinking...</span>
            </div>
          ) : null}
          {panel.answer ? (
            <p className="panelAnswer" aria-live="polite">
              {panel.answer}
              {panel.isStreaming ? <span className="streamCursor" /> : null}
            </p>
          ) : null}
          {panel.error ? <p className="panelError">{panel.error}</p> : null}
        </section>
      </div>
    </aside>
  );
}

function ParagraphOverview({ overview, onClose }) {
  return (
    <aside
      className="paragraphOverview"
      style={{ top: overview.top, left: overview.left }}
      aria-label="Paragraph overview"
    >
      <div className="paragraphOverviewHeader">
        <span>Overview</span>
        <button type="button" onClick={onClose} aria-label="Close paragraph overview">
          x
        </button>
      </div>
      <p className="paragraphOverviewSource">{overview.text}</p>
      {overview.isLoading && !overview.answer ? (
        <div className="loadingState compact" role="status" aria-live="polite">
          <span className="spinner" />
          <span>Reading paragraph...</span>
        </div>
      ) : null}
      {overview.answer ? (
        <p className="paragraphOverviewAnswer" aria-live="polite">
          {overview.answer}
        </p>
      ) : null}
      {overview.error ? <p className="panelError">{overview.error}</p> : null}
    </aside>
  );
}

function PdfDocument({ pdf, zoom, renderZoom }) {
  const pages = useMemo(
    () => Array.from({ length: pdf.numPages }, (_, index) => index + 1),
    [pdf]
  );
  const visualScale = renderZoom ? zoom / renderZoom : 1;

  return (
    <div className="document">
      {pages.map((pageNumber) => (
        <PdfPage
          key={pageNumber}
          pdf={pdf}
          pageNumber={pageNumber}
          renderZoom={renderZoom}
          visualScale={visualScale}
        />
      ))}
    </div>
  );
}

function PdfPage({ pdf, pageNumber, renderZoom, visualScale }) {
  const canvasRef = useRef(null);
  const textLayerRef = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    let cancelled = false;
    let renderTask = null;

    async function renderPage() {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: BASE_SCALE * renderZoom });
      const canvas = canvasRef.current;
      const textLayer = textLayerRef.current;

      if (!canvas || !textLayer || cancelled) return;

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      setSize({ width: viewport.width, height: viewport.height });

      renderTask = page.render({
        canvasContext: canvas.getContext("2d"),
        viewport
      });
      await renderTask.promise;

      if (cancelled) return;

      const textContent = await page.getTextContent({
        includeMarkedContent: true
      });
      renderWordLayer({ textContent, textLayer, viewport, pageNumber });
    }

    renderPage().catch((error) => {
      if (!cancelled && error?.name !== "RenderingCancelledException") {
        console.error(error);
      }
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdf, pageNumber, renderZoom]);

  return (
    <article
      className="pageSlot"
      style={{
        width: size.width ? `${size.width * visualScale}px` : undefined,
        height: size.height ? `${size.height * visualScale}px` : undefined
      }}
      aria-label={`Page ${pageNumber}`}
    >
      <div
        className="page"
        style={{
          width: size.width ? `${size.width}px` : undefined,
          height: size.height ? `${size.height}px` : undefined,
          transform: `scale(${visualScale})`
        }}
      >
        <canvas ref={canvasRef} />
        <div ref={textLayerRef} className="textLayer" />
      </div>
    </article>
  );
}

function renderWordLayer({ textContent, textLayer, viewport, pageNumber }) {
  textLayer.innerHTML = "";
  textLayer.style.width = `${viewport.width}px`;
  textLayer.style.height = `${viewport.height}px`;

  const fragment = document.createDocumentFragment();
  const wordRecords = [];
  let wordIndex = 0;

  for (const item of textContent.items) {
    if (!item?.str?.trim()) continue;

    const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const angle = Math.atan2(transform[1], transform[0]);
    const fontHeight = Math.hypot(transform[2], transform[3]) || item.height * viewport.scale;
    const itemWidth = Math.max(0, item.width * viewport.scale);
    const words = splitTextIntoWordRuns(item.str);

    if (!itemWidth || !fontHeight || !words.length) continue;

    const measuredLength = words.reduce((total, word) => total + word.measure, 0);
    if (!measuredLength) continue;

    let offset = 0;
    for (const word of words) {
      const width = (itemWidth * word.measure) / measuredLength;
      if (word.text.trim()) {
        const span = document.createElement("span");
        span.className = "wordLayerText";
        span.textContent = word.text;
        span.dataset.text = word.text.trim();
        span.dataset.index = String(wordIndex);
        span.dataset.page = String(pageNumber);
        span.style.left = `${transform[4] + offset}px`;
        span.style.top = `${transform[5] - fontHeight}px`;
        span.style.width = `${Math.max(width, 2)}px`;
        span.style.height = `${fontHeight}px`;
        span.style.fontSize = `${fontHeight}px`;

        if (angle) {
          span.style.transform = `rotate(${angle}rad)`;
        }

        fragment.append(span);
        wordRecords.push({
          text: word.text.trim(),
          x: transform[4] + offset,
          y: transform[5] - fontHeight,
          width: Math.max(width, 2),
          height: fontHeight,
          index: wordIndex
        });
        wordIndex += 1;
      }
      offset += width;
    }
  }

  for (const paragraph of getParagraphsFromWords(wordRecords)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "paragraphButton";
    button.dataset.paragraph = paragraph.text;
    button.setAttribute("aria-label", "Simplify this paragraph");
    button.title = "Simplify this paragraph";
    button.style.left = `${paragraph.x + 7}px`;
    button.style.top = `${Math.max(2, paragraph.y - 2)}px`;
    fragment.append(button);
  }

  textLayer.append(fragment);
}

function getParagraphsFromWords(words) {
  if (!words.length) return [];

  const lines = [];
  const sortedWords = [...words].sort((a, b) => a.y - b.y || a.x - b.x);

  for (const word of sortedWords) {
    const line = lines.find(
      (candidate) => Math.abs(candidate.y - word.y) <= Math.max(4, word.height * 0.45)
    );

    if (line) {
      line.words.push(word);
      line.y = Math.min(line.y, word.y);
      line.height = Math.max(line.height, word.height);
    } else {
      lines.push({
        y: word.y,
        height: word.height,
        words: [word]
      });
    }
  }

  lines.sort((a, b) => a.y - b.y);
  for (const line of lines) {
    line.words.sort((a, b) => a.x - b.x);
    line.x = line.words[0].x;
    line.text = line.words.map((word) => word.text).join(" ");
  }

  const paragraphs = [];
  let current = null;

  for (const line of lines) {
    const previous = current?.lines.at(-1);
    const verticalGap = previous ? line.y - (previous.y + previous.height) : 0;
    const indentDelta = previous ? line.x - previous.x : 0;
    const startsNewParagraph =
      !current ||
      verticalGap > line.height * 0.85 ||
      (indentDelta > 18 && current.lines.length > 1);

    if (startsNewParagraph) {
      current = { lines: [line] };
      paragraphs.push(current);
    } else {
      current.lines.push(line);
    }
  }

  return paragraphs
    .map((paragraph) => {
      const firstLine = paragraph.lines[0];
      const text = normalizePdfSelectionText(
        paragraph.lines.map((line) => line.text).join(" ")
      );

      return {
        text,
        x: firstLine.x,
        y: firstLine.y
      };
    })
    .filter((paragraph) => paragraph.text.split(/\s+/).length >= 8);
}

function splitTextIntoWordRuns(text) {
  const runs = [];
  const matches = text.matchAll(/\S+\s*/g);

  for (const match of matches) {
    const textRun = match[0];
    const wordLength = textRun.trimEnd().length;
    const spaceLength = textRun.length - wordLength;

    runs.push({
      text: textRun,
      measure: wordLength + spaceLength * SPACE_WIDTH_RATIO
    });
  }

  return runs;
}

function getCleanSelectedText(activeSelection) {
  if (!activeSelection?.rangeCount) return "";

  const range = activeSelection.getRangeAt(0);
  const selectedWords = Array.from(document.querySelectorAll(".wordLayerText"))
    .filter((node) => {
      try {
        return range.intersectsNode(node);
      } catch {
        return false;
      }
    })
    .map((node) => ({
      text: node.dataset.text || node.textContent || "",
      page: Number(node.dataset.page || 0),
      index: Number(node.dataset.index || 0)
    }))
    .filter((word) => word.text.trim())
    .sort((a, b) => a.page - b.page || a.index - b.index);

  const overlayText = selectedWords.map((word) => word.text).join(" ");
  const browserText = activeSelection.toString().trim();
  return normalizePdfSelectionText(overlayText || browserText);
}

function normalizePdfSelectionText(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b(A|a)(classification|classifier|function|rule|domain)\b/g, "$1 $2")
    .replace(/\b(or|and|where|whose|with|into|from|to)([A-Z]?[a-z]{3,})\b/g, "$1 $2")
    .replace(/\b(function|rule|classifier|domain|space|covariate|input)([A-Za-z])\b/g, "$1 $2")
    .replace(/\b([A-Z])isthe\b/g, "$1 is the")
    .replace(/\b([A-Z])is\b/g, "$1 is")
    .replace(/\bof([A-Z])\b/g, "of $1")
    .replace(/\bK1\b/g, "K - 1")
    .replace(/\b(where)([A-Z])([a-z]+)\b/g, "$1 $2 $3")
    .replace(/([A-Za-z])!([{\w])/g, "$1 -> $2")
    .replace(/([:,{])\s*/g, "$1 ")
    .replace(/\s*([}.])\s*/g, "$1 ")
    .replace(/\{\s*0,\s*\.\s*\.\s*\.\s*,\s*K\s*-\s*1\s*\}/g, "{0, ..., K - 1}")
    .replace(/\s+/g, " ")
    .trim();
}

createRoot(document.getElementById("root")).render(<App />);
