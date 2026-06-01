import express from "express";
import { createServer as createViteServer } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  answerQuestion,
  answerQuestionStream,
  getRuntimeDescription
} from "./lib/answerEngine.mjs";

const app = express();
const port = Number(process.env.PORT || 5173);
const isProduction = process.env.NODE_ENV === "production";
const root = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: "1mb" }));

app.post("/api/ask", async (req, res) => {
  try {
    const { prompt, selection } = req.body || {};

    if (!prompt?.trim() || !selection?.trim()) {
      res.status(400).json({ error: "A prompt and selected PDF text are required." });
      return;
    }

    res.json({
      answer: await answerQuestion({
        prompt: prompt.trim(),
        selection: selection.trim()
      })
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "The model request failed."
    });
  }
});

app.post("/api/ask/stream", async (req, res) => {
  const { prompt, selection } = req.body || {};

  if (!prompt?.trim() || !selection?.trim()) {
    res.status(400).json({ error: "A prompt and selected PDF text are required." });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  try {
    await answerQuestionStream({
      prompt: prompt.trim(),
      selection: selection.trim(),
      onEvent: (event, data) => sendStreamEvent(res, event, data)
    });
    sendStreamEvent(res, "done", {});
  } catch (error) {
    sendStreamEvent(res, "error", {
      error:
        error instanceof Error
          ? error.message
          : "The model request failed."
    });
  } finally {
    res.end();
  }
});

if (isProduction) {
  app.use(express.static(path.join(root, "dist")));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(root, "dist", "index.html"));
  });
} else {
  const vite = await createViteServer({
    root,
    server: { middlewareMode: true },
    appType: "spa"
  });
  app.use(vite.middlewares);
}

app.listen(port, () => {
  console.log(`PDF Reader running at http://127.0.0.1:${port}`);
  console.log(getRuntimeDescription());
});

function sendStreamEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
