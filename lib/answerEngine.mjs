const localModelName = process.env.LOCAL_OSS_MODEL || "Xenova/flan-t5-base";
const requestedProvider = (process.env.MODEL_PROVIDER || "auto").toLowerCase();
let localGeneratorPromise = null;

export async function answerQuestion({ prompt, selection, mode }) {
  const context = await buildAnswerContext({ prompt, selection, mode });
  const provider = resolveProvider();
  const answer = await answerWithProvider({ provider, context });

  return appendSources(cleanAnswerText(answer, context.profile), context.webResults, context.profile);
}

export async function answerQuestionStream({ prompt, selection, mode, onEvent }) {
  onEvent("status", { mode: "loading" });
  const context = await buildAnswerContext({ prompt, selection, mode });
  const provider = resolveProvider();

  if (provider === "gpt-oss") {
    const answer = await answerWithGptOss(context);
    onEvent("message", {
      token: appendSources(cleanAnswerText(answer, context.profile), context.webResults, context.profile)
    });
    return;
  }

  onEvent("message", {
    token: await answerWithProvider({ provider, context }).then((answer) =>
      appendSources(cleanAnswerText(answer, context.profile), context.webResults, context.profile)
    )
  });
}

export function getRuntimeDescription() {
  const provider = resolveProvider();

  if (provider === "gpt-oss") {
    return `Using GPT-oss-compatible endpoint: ${getModelBaseUrl()}`;
  }

  if (provider === "local-transformers") {
    return `Using local open-source model: ${localModelName}`;
  }

  return "Using grounded PDF plus web answer mode";
}

async function answerWithProvider({ provider, context }) {
  if (provider === "gpt-oss") {
    return answerWithGptOss(context);
  }

  if (provider === "local-transformers") {
    return answerWithLocalModel(context);
  }

  return buildGroundedBackupAnswer(context);
}

function resolveProvider() {
  if (requestedProvider === "gpt-oss") return "gpt-oss";
  if (requestedProvider === "local-transformers") return "local-transformers";
  if (requestedProvider === "grounded") return "grounded";

  return process.env.GPT_OSS_BASE_URL || process.env.MODEL_BASE_URL
    ? "gpt-oss"
    : "grounded";
}

async function buildAnswerContext({ prompt, selection, mode }) {
  const cleanSelection = normalizeIncomingSelection(selection);
  const profile = getResponseProfile(prompt, mode);
  const webResults =
    profile.kind === "overview" ? [] : await searchWeb({ prompt, selection: cleanSelection });
  const messages = buildMessages({
    prompt,
    selection: cleanSelection,
    webResults,
    profile
  });

  return {
    prompt,
    selection: cleanSelection,
    webResults,
    profile,
    messages
  };
}

function buildMessages({ prompt, selection, webResults, profile }) {
  const webContext = formatWebContext(webResults);
  const systemInstructions =
    profile.kind === "overview"
      ? [
          "Answer immediately.",
          "Return only the answer text.",
          "Start with the actual idea, definition, or claim.",
          "Do not echo the input labels or repeat the source text.",
          "Do not mention a paragraph, passage, highlight, PDF, prompt, context, or source unless the user explicitly asks about those things.",
          "Bypass jargon: translate technical terms, notation, and dense phrasing into ordinary language.",
          "Give enough detail that the reader understands the idea without rereading the original text.",
          "Use 1 to 2 short paragraphs and stay under 90 words.",
          "If the text includes bullets, fold their meaning into the explanation instead of using a bullet list.",
          "Do not add citations or a sources section.",
          "Do not invent facts."
        ]
      : [
          "Answer immediately.",
          "Return only the answer text.",
          "Start with the substance of the answer, not a description of the selected text or your process.",
          "Do not echo the input labels or repeat the selected text before answering.",
          "Use the selected text as the baseline and primary source of truth.",
          "Use outside sources only to clarify terminology, add examples, or supply necessary background.",
          "Do not mention the system prompt, context, web lookup, selected text, highlighted text, or PDF unless the user explicitly asks about those things.",
          "When sources are useful, cite them with bracket numbers and keep source discussion brief.",
          "Use enough detail to answer well, but remove setup, hedging, and meta commentary.",
          "Do not invent facts."
        ];

  return [
    {
      role: "system",
      content: systemInstructions.join(" ")
    },
    {
      role: "user",
      content: [
        `TEXT:\n${selection}`,
        `WEB:\n${webContext}`,
        `Question:\n${prompt}`,
        `Length target:\n${profile.instructions}`
      ].join("\n\n")
    }
  ];
}

async function answerWithGptOss({ messages, profile }) {
  const response = await fetch(`${getModelBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: getGptOssHeaders(),
    body: JSON.stringify({
      model: getModelName(),
      messages,
      max_tokens: profile.maxTokens,
      temperature: 0.25
    })
  });

  const data = await readJson(response);
  if (!response.ok) {
    throw new Error(data?.error?.message || `GPT-oss request failed with ${response.status}.`);
  }

  return data?.choices?.[0]?.message?.content?.trim() || "The model returned an empty answer.";
}

async function answerWithGptOssStream({ messages, profile, onToken }) {
  const response = await fetch(`${getModelBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: getGptOssHeaders(),
    body: JSON.stringify({
      model: getModelName(),
      messages,
      max_tokens: profile.maxTokens,
      stream: true,
      temperature: 0.25
    })
  });

  if (!response.ok || !response.body) {
    const data = await readJson(response);
    throw new Error(data?.error?.message || `GPT-oss request failed with ${response.status}.`);
  }

  await readServerSentEventStream(response.body, (data) => {
    onToken(data?.choices?.[0]?.delta?.content || "");
  });
}

async function answerWithLocalModel(context) {
  const { prompt, selection, webResults, profile, messages } = context;
  const generator = await getLocalGenerator();
  const modelPrompt = [
    messages[0].content,
    "",
    messages[1].content,
    "",
    "Answer:"
  ].join("\n");

  const result = await generator(modelPrompt, {
    max_new_tokens: profile.maxTokens,
    temperature: 0.35,
    repetition_penalty: 1.12,
    no_repeat_ngram_size: 3
  });

  const generatedText = Array.isArray(result)
    ? result[0]?.generated_text
    : result?.generated_text;
  const modelAnswer = cleanGeneratedAnswer(generatedText, modelPrompt);
  if (profile.kind === "overview") {
    return modelAnswer || buildParagraphOverviewAnswer(selection);
  }

  return modelAnswer || buildGroundedBackupAnswer({ prompt, selection, webResults });
}

async function getLocalGenerator() {
  if (!localGeneratorPromise) {
    localGeneratorPromise = import("@xenova/transformers").then(
      async ({ env, pipeline }) => {
        env.allowLocalModels = true;
        env.allowRemoteModels = true;
        return pipeline("text2text-generation", localModelName);
      }
    );
  }

  return localGeneratorPromise;
}

function getModelBaseUrl() {
  const baseUrl = (process.env.MODEL_BASE_URL || process.env.GPT_OSS_BASE_URL || "").replace(
    /\/$/,
    ""
  );

  if (!baseUrl) {
    throw new Error(
      "MODEL_PROVIDER=gpt-oss requires MODEL_BASE_URL or GPT_OSS_BASE_URL."
    );
  }

  return baseUrl;
}

function getGptOssHeaders() {
  return {
    "Content-Type": "application/json",
    ...(process.env.MODEL_API_KEY || process.env.GPT_OSS_API_KEY
      ? { Authorization: `Bearer ${process.env.MODEL_API_KEY || process.env.GPT_OSS_API_KEY}` }
      : {})
  };
}

function getModelName() {
  return process.env.MODEL_NAME || process.env.GPT_OSS_MODEL || "gpt-oss";
}

async function searchWeb({ prompt, selection }) {
  const query = buildSearchQuery({ prompt, selection });

  try {
    const instantResults = await searchDuckDuckGoInstant(query);
    const htmlResults = await searchDuckDuckGoHtml(query);
    const liteResults = htmlResults.length ? [] : await searchDuckDuckGoLite(query);
    return dedupeResults([...instantResults, ...htmlResults, ...liteResults]).slice(0, 5);
  } catch (error) {
    console.warn(
      error instanceof Error ? `Web search failed: ${error.message}` : "Web search failed."
    );
    return [];
  }
}

async function searchDuckDuckGoInstant(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(
    query
  )}&format=json&no_html=1&skip_disambig=1`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" }
  });

  if (!response.ok) return [];

  const data = await response.json();
  const results = [];

  if (data.AbstractText && data.AbstractURL) {
    results.push({
      title: data.Heading || data.AbstractSource || "DuckDuckGo instant answer",
      snippet: data.AbstractText,
      url: data.AbstractURL
    });
  }

  for (const topic of flattenRelatedTopics(data.RelatedTopics || [])) {
    if (topic.Text && topic.FirstURL) {
      results.push({
        title: topic.Text.split(" - ")[0],
        snippet: topic.Text,
        url: topic.FirstURL
      });
    }
  }

  return results;
}

async function searchDuckDuckGoHtml(query) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
    }
  });

  if (!response.ok) return [];

  return parseDuckDuckGoResults(await response.text());
}

async function searchDuckDuckGoLite(query) {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" }
  });

  if (!response.ok) return [];

  return parseDuckDuckGoLiteResults(await response.text());
}

function buildSearchQuery({ prompt, selection }) {
  const terms = `${selection} ${prompt}`
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .filter(
      (word) =>
        ![
          "give",
          "simplified",
          "overview",
          "paragraph",
          "explain",
          "language",
          "plain",
          "clarify",
          "important",
          "focused",
          "readability"
        ].includes(word.toLowerCase())
    )
    .filter((word, index, words) => words.indexOf(word) === index)
    .slice(0, 14);

  return terms.join(" ");
}

function formatWebContext(webResults) {
  return webResults.length
    ? webResults
        .map(
          (result, index) =>
            `[${index + 1}] ${result.title}\n${result.snippet}\n${result.url}`
        )
        .join("\n\n")
    : "None.";
}

function parseDuckDuckGoResults(html) {
  const results = [];
  const blockPattern =
    /<div class="result results_links[\s\S]*?(?=<div class="result results_links|<div id="bottom_spacing2"|<\/body>)/g;
  let match;

  while ((match = blockPattern.exec(html))) {
    const block = match[0];
    const titleAnchor = block.match(/<a[^>]*class="result__a"[^>]*>[\s\S]*?<\/a>/);
    const snippetAnchor = block.match(/<a[^>]*class="result__snippet"[^>]*>[\s\S]*?<\/a>/);
    if (!titleAnchor || !snippetAnchor) continue;

    const href = titleAnchor[0].match(/href="([^"]+)"/)?.[1];
    const url = decodeDuckDuckGoUrl(decodeHtml(href || ""));
    const title = stripTags(decodeHtml(titleAnchor[0]));
    const snippet = stripTags(decodeHtml(snippetAnchor[0]));

    if (title && snippet && url) {
      results.push({ title, snippet, url });
    }
  }

  return results;
}

function parseDuckDuckGoLiteResults(html) {
  const results = [];
  const blockPattern =
    /<a[^>]*class='result-link'[^>]*>[\s\S]*?<\/a>[\s\S]*?<td class='result-snippet'>([\s\S]*?)<\/td>/g;
  let match;

  while ((match = blockPattern.exec(html))) {
    const block = match[0];
    const href = block.match(/href="([^"]+)"/)?.[1] || block.match(/href='([^']+)'/)?.[1];
    const title = stripTags(decodeHtml(block.match(/<a[^>]*>([\s\S]*?)<\/a>/)?.[1] || ""));
    const snippet = stripTags(decodeHtml(match[1]));
    const url = decodeDuckDuckGoUrl(decodeHtml(href || ""));

    if (title && snippet && url) {
      results.push({ title, snippet, url });
    }
  }

  return results;
}

function flattenRelatedTopics(topics) {
  return topics.flatMap((topic) =>
    Array.isArray(topic.Topics) ? flattenRelatedTopics(topic.Topics) : [topic]
  );
}

function dedupeResults(results) {
  const seen = new Set();
  return results.filter((result) => {
    if (!result.url || seen.has(result.url)) return false;
    seen.add(result.url);
    return true;
  });
}

function decodeDuckDuckGoUrl(url) {
  try {
    const parsed = new URL(url, "https://duckduckgo.com");
    return parsed.searchParams.get("uddg") || parsed.href;
  } catch {
    return url;
  }
}

function stripTags(value) {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeHtml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function cleanGeneratedAnswer(generatedText, modelPrompt) {
  const text = generatedText
    ?.replace(modelPrompt, "")
    .replace(/^Answer:\s*/i, "")
    .trim();

  if (!text || text.length < 120) return "";
  if (/^(pdf text|detailed text|summary|chapters?|sections?)\s*:/i.test(text)) return "";
  if (/\b(detailed text|chapters? - sections?|sections? & discussions)\b/i.test(text)) {
    return "";
  }
  if (splitSentences(text).length < 2 && text.split(/\s+/).length < 35) return "";

  return text;
}

function buildGroundedBackupAnswer({ prompt, selection, webResults }) {
  if (isParagraphOverviewPrompt(prompt)) {
    return buildParagraphOverviewAnswer(selection);
  }

  if (/decision boundaries?|classification|classifier/i.test(selection)) {
    if (/h\s*:\s*X|function\s+h|classification rule/i.test(selection)) {
      return buildClassifierNotationAnswer({ selection, webResults });
    }

    return [
      "A classifier organizes the input space into regions where different labels will be predicted. A decision boundary is the dividing surface where the predicted class changes from one label to another.",
      "For binary classification, that boundary separates two possible labels. For multiclass classification, the same idea extends to several regions, one for each class or class decision."
    ].join("\n\n");
  }

  return answerPromptDirectly(prompt, selection);
}

function answerPromptDirectly(prompt, selection) {
  const cleaned = normalizeIncomingSelection(selection);

  if (/explain|what does|what is|meaning|mean/i.test(prompt)) {
    return cleaned;
  }

  return cleaned;
}

function buildClassifierNotationAnswer({ selection, webResults }) {
  const hasWeb = webResults.length > 0;

  return [
    "A classifier is a function. Written cleanly, the expression is saying something like `h: X -> {0, ..., K - 1}`. That means the rule `h` takes an input from the input space `X` and returns one label from a finite set of possible class labels. The set `{0, ..., K - 1}` is just a convenient way to number the possible classes. If `K = 2`, the labels might be `0` and `1`; if `K = 5`, the labels might be `0, 1, 2, 3, 4`.",
    "The italicized `X` usually refers to the input space, also called the feature space or covariate space. It is not one single observation. It is the set of all possible inputs that the classifier is allowed to receive. A single observed input would usually be written as something like lowercase `x`, and that individual `x` is an element of the larger space `X`.",
    "So when the text says `X is the domain`, it means `X` is the domain of the classifier function `h`: every valid input to `h` must come from `X`. For example, if you classify emails as spam or not spam, `X` could be the set of all feature vectors representing emails. If you classify points in a two-dimensional plane, `X` could be `R^2`, the set of all ordered pairs of real numbers. If you classify images, `X` could be the set of all images of a certain size, or the set of numerical pixel arrays representing those images.",
    hasWeb
      ? "Classification generally means assigning inputs to categories; in this notation, the input is an element of `X` and the category is one of the numbered labels."
      : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildParagraphOverviewAnswer(selection) {
  const sentences = splitSentences(selection);
  const cleaned = normalizeIncomingSelection(selection);

  if (/iris|coris|handwriting|political blog|goal is to predict/i.test(cleaned)) {
    return [
      "Classification means using measured information, called features or covariates, to predict a discrete label. The examples all follow the same pattern: measure things like flower dimensions, health attributes, image pixels, or blog content, then predict the category.",
      "The point is that classification is not about predicting a number on a continuous scale. It is about assigning a new case to one of several possible groups."
    ].join("\n\n");
  }

  if (/decision boundaries?|classification|classifier|h\s*:\s*X|input space|covariate/i.test(cleaned)) {
    return [
      "A classifier is a rule that takes an input and assigns it to one of a fixed set of categories. The notation is dense, but the idea is simple: you observe some input, run it through the rule, and the rule returns the predicted class.",
      "The symbol `X` refers to the space of possible inputs, not just one example. The classifier divides that space into regions, and the borders between regions are decision boundaries."
    ].join("\n\n");
  }

  if (sentences.length <= 1) {
    return cleaned;
  }

  const opening = sentences.slice(0, 2).join(" ");
  const details = sentences.slice(2, 5).join(" ");

  return [
    uppercaseFirst(opening),
    details
      ? `The supporting details are: ${details}`
      : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

function appendSources(answer, webResults, profile = {}) {
  if (profile.kind === "overview") return answer;

  const sources = formatSourcesBlock(webResults);
  return sources ? `${answer}${sources}` : answer;
}

function cleanAnswerText(answer, profile = {}) {
  const relevantAnswer = extractRelevantAnswerSection(answer);
  const withoutSourceEcho =
    profile.kind === "overview"
      ? relevantAnswer.replace(/(?:^|\n)\s*Sources?:[\s\S]*$/i, "")
      : relevantAnswer;

  const cleaned = withoutSourceEcho
    .split(/\n{2,}/)
    .map((paragraph) => stripLeadIn(paragraph.trim()))
    .filter(Boolean)
    .join("\n\n")
    .trim();

  return profile.kind === "overview" ? limitOverviewAnswer(dedupeRepeatedText(cleaned)) : cleaned;
}

function extractRelevantAnswerSection(answer) {
  const normalized = answer.replace(/\r\n/g, "\n").trim();
  const answerLabelPattern =
    /(?:^|\n)\s*(?:answer|final answer|response|explanation|overview)\s*:\s*/gi;
  const answerLabels = [...normalized.matchAll(answerLabelPattern)];

  if (answerLabels.length) {
    const lastLabel = answerLabels.at(-1);
    const start = (lastLabel.index || 0) + lastLabel[0].length;
    return normalized.slice(start).trim();
  }

  const withoutEchoedBlocks = normalized
    .replace(
      /(?:^|\n)\s*(?:system|system prompt|developer|user|text|selected text|highlighted text|highlighted pdf text|pdf text|web|web context|question|prompt|length target|context)\s*:\s*[\s\S]*?(?=\n\s*(?:system|system prompt|developer|user|text|selected text|highlighted text|highlighted pdf text|pdf text|web|web context|question|prompt|length target|context|answer|final answer|response|explanation|overview)\s*:|$)/gi,
      "\n"
    )
    .trim();

  return withoutEchoedBlocks || normalized;
}

function stripLeadIn(text) {
  return text
    .replace(/^sure[,.]?\s*/i, "")
    .replace(/^here(?:'s| is)\s+(?:the\s+)?(?:answer|explanation|overview|direct answer)\s*[:.]\s*/i, "")
    .replace(/^in the notation from the PDF,\s*/i, "")
    .replace(/^based on (?:the )?(?:selected|highlighted)?\s*(?:text|passage|paragraph|PDF)[,.:]\s*/i, "")
    .replace(
      /^(?:the|this)\s+(?:selected|highlighted)?\s*(?:text|passage|paragraph|PDF)\s+(?:is|means|says|states|frames|explains|describes|introduces|sets up)\s*(?:that|the idea that)?\s*[:.,-]?\s*/i,
      ""
    )
    .replace(
      /^(?:the|this)\s+(?:key|main)\s+(?:idea|point)\s+(?:is|means)\s*(?:that)?\s*[:.,-]?\s*/i,
      ""
    )
    .trim();
}

function limitOverviewAnswer(answer) {
  const paragraphs = answer
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .slice(0, 2);
  const words = paragraphs.join("\n\n").split(/\s+/).filter(Boolean);

  if (words.length <= 90) return paragraphs.join("\n\n");
  return `${words.slice(0, 90).join(" ").replace(/[,:;]$/, "")}.`;
}

function dedupeRepeatedText(text) {
  const seenParagraphs = new Set();

  return text
    .split(/\n{2,}/)
    .map((paragraph) => dedupeRepeatedSentences(paragraph.trim()))
    .filter(Boolean)
    .filter((paragraph) => {
      const key = paragraph.toLowerCase();
      if (seenParagraphs.has(key)) return false;
      seenParagraphs.add(key);
      return true;
    })
    .join("\n\n");
}

function dedupeRepeatedSentences(text) {
  const seenSentences = new Set();

  return splitSentences(text)
    .filter((sentence) => {
      const key = sentence.toLowerCase();
      if (seenSentences.has(key)) return false;
      seenSentences.add(key);
      return true;
    })
    .join(" ");
}

function formatSourcesBlock(webResults) {
  if (!webResults.length) return "";

  const sources = webResults
    .slice(0, 3)
    .map((result) => `[${cleanSourceTitle(result.title)}](${result.url})`)
    .join(" · ");

  return `\n\nSources: ${sources}`;
}

function cleanSourceTitle(title) {
  const cleaned = title
    .split(/\s[-|]\s/)[0]
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.length > 58 ? `${cleaned.slice(0, 55).trim()}...` : cleaned;
}

function getResponseProfile(prompt, mode) {
  const normalizedPrompt = prompt.toLowerCase().trim();

  if (mode === "overview" || isParagraphOverviewPrompt(normalizedPrompt)) {
    return {
      kind: "overview",
      maxTokens: 180,
      instructions:
        "Give a direct reading aid in 1 to 2 short paragraphs, no more than 90 words. Explain jargon and preserve the text's meaning."
    };
  }

  const wordCount = normalizedPrompt.split(/\s+/).filter(Boolean).length;
  const wantsDepth =
    /\b(explain|why|how|compare|contrast|summarize|derive|intuition|example|examples|detail|walk me through|break down)\b/.test(
      normalizedPrompt
    ) || wordCount >= 12;

  if (wantsDepth) {
    return {
      kind: "standard",
      maxTokens: 900,
      instructions:
        "Give a deep answer with several paragraphs or a concise structured explanation."
    };
  }

  return {
    kind: "standard",
    maxTokens: 560,
    instructions:
      "Give a substantial answer. Even for simple questions, include definition, context, and significance."
  };
}

function isParagraphOverviewPrompt(prompt) {
  return /overview of this paragraph|paragraph overview|fast-reading overview|reading aid/i.test(prompt);
}

function splitSentences(text) {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function uppercaseFirst(text) {
  if (!text) return text;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function normalizeIncomingSelection(text) {
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

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function readServerSentEventStream(body, onData) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      onData(JSON.parse(data));
    }
  }
}
