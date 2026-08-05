const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onRequest} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

// Set this once with:
//   firebase functions:secrets:set ANTHROPIC_API_KEY
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

// Swap this for whichever current Claude model you want to use / can afford
// to call twice a week (Sonnet is a good default balance of quality vs cost).
const MODEL = "claude-sonnet-5";
// A faster, lighter model for calls where speed matters more than depth of
// reasoning (e.g. generating a short structured suggestions list).
const FAST_MODEL = "claude-haiku-4-5-20251001";

async function callClaude(prompt, maxTokens, opts) {
  const options = opts || {};
  const body = {
    model: options.model || MODEL,
    max_tokens: maxTokens || 1500,
    messages: [{role: "user", content: prompt}],
  };
  if (options.tools) {
    body.tools = options.tools;
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY.value(),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }
  const data = await res.json();
  // With web search enabled, the response can interleave server_tool_use /
  // web_search_tool_result blocks with multiple text blocks (citations split
  // the text up). Concatenate every text block in order, not just the first.
  const textBlocks = (data.content || []).filter((b) => b.type === "text");
  if (data.stop_reason === "max_tokens") {
    console.warn("callClaude: response was truncated by max_tokens — consider raising the cap");
  }
  return textBlocks.map((b) => b.text).join("");
}

function extractJson(text) {
  let cleaned = text.replace(/```json|```/g, "").trim();
  // If there's leading/trailing prose around the JSON, grab the outermost
  // {...} or [...] span instead of assuming the whole string is JSON.
  const firstBrace = cleaned.search(/[{[]/);
  if (firstBrace > 0) {
    cleaned = cleaned.slice(firstBrace);
  }
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    // Response likely got cut off mid-object (max_tokens truncation). Try to
    // salvage a valid partial result: walk backward from the end to the last
    // point where brackets/braces/quotes were all balanced, trim there, and
    // close off whatever's still open.
    const repaired = repairTruncatedJson(cleaned);
    if (repaired !== null) {
      console.warn("extractJson: repaired a truncated response");
      return repaired;
    }
    throw err;
  }
}

function repairTruncatedJson(cleaned) {
  const opener = cleaned[0];
  if (opener !== "[" && opener !== "{") return null;
  const closer = opener === "[" ? "]" : "}";
  // Scan forward tracking nesting depth and string state; remember every
  // index where we're back at depth 1 right after closing a complete element
  // (a top-level comma, or the position just before a top-level closer).
  let depth = 0;
  let inString = false;
  let escape = false;
  let lastSafeCut = -1;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 1) lastSafeCut = i + 1; // just closed a complete element
    } else if (ch === "," && depth === 1) {
      lastSafeCut = i; // safe to cut right before this comma
    }
  }
  if (lastSafeCut === -1) return null;
  const candidate = cleaned.slice(0, lastSafeCut) + closer;
  try {
    return JSON.parse(candidate);
  } catch (e) {
    return null;
  }
}

async function runSuggestionsRefresh() {
  const db = admin.database();
  const [fragsSnap, acquiredSnap] = await Promise.all([
    db.ref("/fragrances").get(),
    db.ref("/collection").get(),
  ]);
  const frags = fragsSnap.val() || [];
  const acquired = acquiredSnap.val() || {};
  const fragList = Array.isArray(frags) ? frags : Object.values(frags);
  const owned = fragList
      .filter((f) => f && acquired[f.id])
      .map((f) => `${f.name} (${f.house}) — notes: ${(f.notes || []).join(", ")}`);

  const prompt = `You are a fragrance curator helping a collector expand their collection.

Here is what they currently own:
${owned.length ? owned.map((o) => "- " + o).join("\n") : "(nothing logged yet)"}

Suggest exactly 9 real, currently-available fragrances they don't already own that
would round out or elevate their collection: 3 affordable (under $80), 3 mid-range
($80-200), 3 luxury ($200+). Prefer variety across everyday / professional / date
night / special occasion use cases, and avoid repeating anything too similar to
what they already own.

Respond with ONLY a JSON array — your entire response must start with [ and
end with ], with no prose, no markdown fences, no explanation, and no text
before or after it. Keep every "reason" under 10 words and every entry
compact — this needs to generate fast, not read like a review. Shape:
[
  {
    "id": "kebab-case-unique-id",
    "name": "...",
    "house": "...",
    "price": "~$XX",
    "tier": "affordable" | "mid" | "luxury",
    "tags": ["2-3 notes or descriptors"],
    "dupe": false,
    "dupeOf": null,
    "reason": "under 10 words, specific to their collection above"
  }
]`;

  const raw = await callClaude(prompt, 3000, {model: FAST_MODEL});
  const suggestions = extractJson(raw);
  if (!Array.isArray(suggestions)) throw new Error("Response was not an array");
  if (suggestions.length < 3) throw new Error(`Only got ${suggestions.length} usable suggestions, discarding`);

  await db.ref("/suggestions").set(suggestions);
  await db.ref("/suggestionsMeta").set({refreshedAt: Date.now()});
  console.log(`refreshSuggestions: wrote ${suggestions.length} suggestions`);
  return suggestions;
}

// ── SCHEDULED: refresh Suggested Purchases every Sunday & Thursday at midnight ──
// Cron "0 0 * * 0,4" = 00:00 on Sunday(0) and Thursday(4).
exports.refreshSuggestions = onSchedule(
    {
      schedule: "0 0 * * 0,4",
      timeZone: "America/Chicago",
      secrets: [ANTHROPIC_API_KEY],
    },
    async () => {
      try {
        await runSuggestionsRefresh();
      } catch (err) {
        console.error("refreshSuggestions: failed to get/parse suggestions", err);
      }
    },
);

// ── HTTPS: manual trigger for the same refresh, for testing without waiting
// for the Sun/Thu schedule. Hit this URL directly in a browser or with curl.
// Consider removing or gating this once you've confirmed everything works.
exports.refreshSuggestionsNow = onRequest(
    {secrets: [ANTHROPIC_API_KEY], cors: true, timeoutSeconds: 120},
    async (req, res) => {
      try {
        const suggestions = await runSuggestionsRefresh();
        res.json({ok: true, count: suggestions.length});
      } catch (err) {
        console.error("refreshSuggestionsNow error", err);
        res.status(500).json({ok: false, error: "refresh failed"});
      }
    },
);


// ── HTTPS: collection coverage / weak-point analysis ──
// GET /analyzeCoverage — reads /fragrances + /collection, asks Claude to
// identify gaps in coverage across occasions/notes/intensity.
exports.analyzeCoverage = onRequest(
    {secrets: [ANTHROPIC_API_KEY], cors: true},
    async (req, res) => {
      try {
        const db = admin.database();
        const [fragsSnap, acquiredSnap] = await Promise.all([
          db.ref("/fragrances").get(),
          db.ref("/collection").get(),
        ]);
        const frags = fragsSnap.val() || [];
        const acquired = acquiredSnap.val() || {};
        const fragList = Array.isArray(frags) ? frags : Object.values(frags);
        const owned = fragList.filter((f) => f && acquired[f.id]);

        if (owned.length === 0) {
          res.json({summary: "No acquired fragrances yet — add some to your Collection first.", gaps: []});
          return;
        }

        const ownedText = owned.map((f) =>
          `- ${f.name} (${f.house}) [${f.slot}] — notes: ${(f.notes || []).join(", ") || "none listed"}, longevity: ${f.longevity || "?"}, sprays: ${f.maxSprays || "?"}`,
        ).join("\n");

        const prompt = `You are a fragrance collection analyst. Here is a collector's
current owned fragrances, with the occasion category they're filed under in brackets:

${ownedText}

Identify weak points and gaps in their coverage — categories that are thin,
imbalanced, missing an occasion/intensity/season option, or too repetitive in
notes/character. Be specific and reference actual fragrances or categories from
the list above rather than generic advice.

Respond with ONLY this JSON — your entire response must start with { and end
with }, no prose, no markdown fences, no text before or after it. Keep
"issue" and "suggestion" each to one short sentence so the response stays
compact:
{
  "summary": "2-3 sentence overview of how balanced the collection is overall",
  "gaps": [
    {
      "category": "Everyday | Professional | Date Night | Special Occasion | Unknown | General",
      "issue": "specific description of the gap, referencing what they own",
      "suggestion": "what kind of fragrance (character/notes, not a specific product) would fill it"
    }
  ]
}
Include 3-6 gaps, ordered by importance.`;

        const raw = await callClaude(prompt, 3200);
        const parsed = extractJson(raw);
        res.json(parsed);
      } catch (err) {
        console.error("analyzeCoverage error", err);
        res.status(500).json({error: "analysis failed"});
      }
    },
);

// GET /lookupFragrance?q=<search text>
exports.lookupFragrance = onRequest(
    {secrets: [ANTHROPIC_API_KEY], cors: true, timeoutSeconds: 90},
    async (req, res) => {
      const q = (req.query.q || (req.body && req.body.q) || "").toString().trim();
      if (!q) {
        res.status(400).json({found: false, error: "missing query"});
        return;
      }

      const prompt = `Search text: "${q}"

First decide: is this search text naming a specific fragrance (e.g. "Sauvage",
"Baccarat Rouge 540"), or is it naming a fragrance HOUSE/BRAND as a whole
(e.g. "Dior", "Maison Francis Kurkdjian", "Creed")?

Then search the web (use as few searches as you can to answer confidently —
usually 1, at most 2) and respond with ONLY this JSON — your entire response
must start with { and end with }, no prose, no markdown fences, no text
before or after it:
{
  "found": true|false,
  "queryType": "house"|"fragrance",
  "candidates": [
    {"name":"...","house":"...","tags":["2-3 notes"],"price":"~$85","reason":"under 12 words"}
  ]
}

Rules for candidates:
- If queryType is "fragrance": include exactly 1 candidate, UNLESS the name
  genuinely matches multiple different real fragrances (e.g. reused across
  houses) — then include up to 3.
- If queryType is "house": list EVERY current, real, notable fragrance you can
  verify that house sells right now — do not cap at 3, include as many as you
  can confidently confirm (commonly 5-15). Keep each "reason" very short.
- Keep every field concise — this is a quick-reference list, not a review.
- If nothing confidently matches, respond with {"found":false,"queryType":"fragrance","candidates":[]}.`;

      try {
        const raw = await callClaude(prompt, 2600, {
          tools: [{type: "web_search_20250305", name: "web_search", max_uses: 2}],
        });
        const parsed = extractJson(raw);
        if (!parsed.candidates) parsed.candidates = [];
        res.json(parsed);
      } catch (err) {
        console.error("lookupFragrance error", err);
        res.status(500).json({found: false, candidates: [], error: "lookup failed"});
      }
    },
);

// GET /lookupNotes?name=<fragrance>&house=<house>
// Uses web search to pull the real note pyramid, preferring Fragrantica and
// the brand's own official site over blogs/retailers, so the Closet shows
// accurate top/heart/base notes (and therefore an accurate derived color)
// instead of guessing from a flat tag list.
exports.lookupNotes = onRequest(
    {secrets: [ANTHROPIC_API_KEY], cors: true, timeoutSeconds: 90},
    async (req, res) => {
      const name = (req.query.name || "").toString().trim();
      const house = (req.query.house || "").toString().trim();
      if (!name) {
        res.status(400).json({found: false, error: "missing name"});
        return;
      }

      const prompt = `Find the official fragrance note pyramid for:
Fragrance: "${name}"
House/Brand: "${house}"

Search the web for this specific fragrance's notes. Source priority, highest
first:
  1. Fragrantica (fragrantica.com) — the note pyramid on the product page
  2. The brand's own official website product page
  3. A major authorized retailer (Sephora, Nordstrom, Notino, etc.)
Do NOT use blog posts, Reddit, or reseller listings if any of the above are
available. If sources disagree, prefer the higher-priority source.

Respond with ONLY this JSON — start with { and end with }, no prose, no
markdown fences:
{
  "found": true|false,
  "source": "fragrantica" | "official" | "retailer" | "none",
  "top": ["note", "note"],
  "heart": ["note", "note"],
  "base": ["note", "note"],
  "accords": ["2-4 dominant accords, e.g. woody, sweet, fresh spicy"]
}

Rules:
- Use the real note names as listed by the source (e.g. "Calabrian bergamot",
  "Ambroxan"), not invented ones.
- 2-5 notes per tier is plenty; list the most prominent ones.
- If you cannot confidently find this exact fragrance, respond with
  {"found":false,"source":"none","top":[],"heart":[],"base":[],"accords":[]}.
  Do not guess.`;

      try {
        const raw = await callClaude(prompt, 1200, {
          tools: [{type: "web_search_20250305", name: "web_search", max_uses: 3}],
        });
        const parsed = extractJson(raw);
        ["top", "heart", "base", "accords"].forEach((k) => {
          if (!Array.isArray(parsed[k])) parsed[k] = [];
        });
        res.json(parsed);
      } catch (err) {
        console.error("lookupNotes error", err);
        res.status(500).json({found: false, error: "notes lookup failed"});
      }
    },
);
