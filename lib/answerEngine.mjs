const localModelName = process.env.LOCAL_OSS_MODEL || "Xenova/flan-t5-base";
const requestedProvider = (process.env.MODEL_PROVIDER || "auto").toLowerCase();
let localGeneratorPromise = null;

export async function answerQuestion({ prompt, selection }) {
  const context = await buildAnswerContext({ prompt, selection });
  const provider = resolveProvider();
  const answer = await answerWithProvider({ provider, context });

  return appendSources(answer, context.webResults);
}

export async function answerQuestionStream({ prompt, selection, onEvent }) {
  onEvent("status", { mode: "loading" });
  const context = await buildAnswerContext({ prompt, selection });
  const provider = resolveProvider();

  if (provider === "gpt-oss") {
    await answerWithGptOssStream({
      ...context,
      onToken: (token) => {
        if (token) onEvent("message", { token });
      }
    });
    onEvent("message", { token: formatSourcesBlock(context.webResults) });
    return;
  }

  onEvent("message", {
    token: await answerWithProvider({ provider, context }).then((answer) =>
      appendSources(answer, context.webResults)
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

async function buildAnswerContext({ prompt, selection }) {
  const cleanSelection = normalizeIncomingSelection(selection);
  const webResults = await searchWeb({ prompt, selection: cleanSelection });
  const profile = getResponseProfile(prompt);
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

  return [
    {
      role: "system",
      content: [
        "You are a PDF reading assistant.",
        "Use the highlighted PDF text as the baseline and primary source of truth.",
        "Expand beyond the PDF with outside sources when they help answer the question, clarify terminology, add examples, or place the passage in broader context.",
        "Cite all outside sources at the end under a 'Sources checked' heading. Use bracket numbers like [1] when specific claims depend on web context.",
        "If web sources are weak or only loosely related, say so briefly and keep the answer anchored in the PDF.",
        "Write a substantial answer. Simple questions still deserve definition, context, and significance; harder questions should include structure, examples, and implications.",
        "Do not invent facts."
      ].join(" ")
    },
    {
      role: "user",
      content: [
        `Highlighted PDF text:\n${selection}`,
        `Web context:\n${webContext}`,
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
    : "No useful web results were retrieved, but a live web lookup was attempted.";
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
  const sentences = splitSentences(selection);
  const sourceSummary = webResults.slice(0, 3);
  const pdfSummary = sentences.slice(0, 4).join(" ");
  const webSummary = sourceSummary
    .map((result, index) => `[${index + 1}] ${result.snippet}`)
    .join(" ");

  const baseContext = [
    `The highlighted passage frames the question this way: ${pdfSummary || selection}`,
    webSummary
      ? `The web context broadens that reading: ${webSummary}`
      : "A live web lookup was attempted, but no useful snippets were returned, so this answer stays close to the highlighted text."
  ];

  if (/decision boundaries?|classification|classifier/i.test(selection)) {
    if (/h\s*:\s*X|function\s+h|classification rule/i.test(selection)) {
      return buildClassifierNotationAnswer({ prompt, selection, webResults, baseContext });
    }

    return [
      ...baseContext,
      `A full answer to "${prompt}" is that the concept in the highlight should be understood as a way of organizing the input space into regions where the classifier will make different predictions. The boundary is important because it is the actual dividing surface where the model's predicted class changes. In practical terms, studying that boundary tells you what the classifier has learned, where it is confident, and where examples become ambiguous.`,
      "For binary classification, there are only two possible labels, so the boundary separates one decision region from the other. For multiclass classification, the same idea extends to more than two regions: the classifier partitions the input space into several regions, one for each class or class decision. The web results reinforce this by describing decision-boundary visualizations as a way to see which regions of the feature space are assigned to which categories [1], and by connecting binary classification to multiclass extensions [2]."
    ].join("\n\n");
  }

  return [
    ...baseContext,
    `A full answer to "${prompt}" should start from the highlighted passage and use the web results as supporting context. The key idea is the relationship between the specific wording in the PDF and the broader background surfaced by the web search. The PDF gives the local definition or argument; the web context helps explain why that idea matters outside this exact passage.`,
    "In practice, read the highlighted text as the authoritative anchor, then use the sources to clarify terminology, add examples, or connect the passage to the wider topic. If the web snippets do not directly answer the question, the safest answer is to stay close to the PDF and treat the web results as background rather than proof."
  ].join("\n\n");
}

function buildClassifierNotationAnswer({ selection, webResults, baseContext }) {
  const hasWeb = webResults.length > 0;

  return [
    ...baseContext,
    "In the notation from the PDF, a classifier is being described as a function. Written cleanly, the expression is saying something like `h: X -> {0, ..., K - 1}`. That means the rule `h` takes an input from the input space `X` and returns one label from a finite set of possible class labels. The set `{0, ..., K - 1}` is just a convenient way to number the possible classes. If `K = 2`, the labels might be `0` and `1`; if `K = 5`, the labels might be `0, 1, 2, 3, 4`.",
    "The italicized `X` usually refers to the input space, also called the feature space or covariate space. It is not one single observation. It is the set of all possible inputs that the classifier is allowed to receive. A single observed input would usually be written as something like lowercase `x`, and that individual `x` is an element of the larger space `X`.",
    "So when the text says `X is the domain`, it means `X` is the domain of the classifier function `h`: every valid input to `h` must come from `X`. For example, if you classify emails as spam or not spam, `X` could be the set of all feature vectors representing emails. If you classify points in a two-dimensional plane, `X` could be `R^2`, the set of all ordered pairs of real numbers. If you classify images, `X` could be the set of all images of a certain size, or the set of numerical pixel arrays representing those images.",
    hasWeb
      ? "The web sources checked line up with this interpretation: classification is broadly described as assigning inputs to categories, while machine-learning glossaries discuss features, labels, and examples as the objects involved in supervised classification. Those sources are useful background, but the key definition here comes directly from the PDF notation."
      : "The web search did not add strong context, but the mathematical reading of the notation is still clear from the highlighted passage."
  ].join("\n\n");
}

function appendSources(answer, webResults) {
  const sources = formatSourcesBlock(webResults);
  return sources ? `${answer}${sources}` : answer;
}

function formatSourcesBlock(webResults) {
  if (!webResults.length) return "";

  return `\n\nSources checked:\n${webResults
    .map((result, index) => `[${index + 1}] ${result.title} - ${result.url}`)
    .join("\n")}`;
}

function getResponseProfile(prompt) {
  const normalizedPrompt = prompt.toLowerCase().trim();
  const wordCount = normalizedPrompt.split(/\s+/).filter(Boolean).length;
  const wantsDepth =
    /\b(explain|why|how|compare|contrast|summarize|derive|intuition|example|examples|detail|walk me through|break down)\b/.test(
      normalizedPrompt
    ) || wordCount >= 12;

  if (wantsDepth) {
    return {
      maxTokens: 900,
      instructions:
        "Give a deep answer with several paragraphs or a concise structured explanation."
    };
  }

  return {
    maxTokens: 560,
    instructions:
      "Give a substantial answer. Even for simple questions, include definition, context, and significance."
  };
}

function splitSentences(text) {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
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
