import { answerQuestionStream } from "../../lib/answerEngine.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method not allowed." }));
    return;
  }

  const { prompt, selection, mode } = req.body || {};

  if (!prompt?.trim() || !selection?.trim()) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "A prompt and selected PDF text are required." }));
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  try {
    await answerQuestionStream({
      prompt: prompt.trim(),
      selection: selection.trim(),
      mode,
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
}

function sendStreamEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
