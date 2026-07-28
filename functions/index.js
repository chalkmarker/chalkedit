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

async function callClaude(prompt, maxTokens) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY.value(),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens || 1500,
      messages: [{role: "user", content: prompt}],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (data.stop_reason === "max_tokens") {
    console.warn("callClaude: response was truncated by max_tokens — consider raising the cap");
  }
  return textBlock ? textBlock.text : "";
}

function extractJson(text) {
  let cleaned = text.replace(/```json|```/g, "").trim();
  // If there's leading/trailing prose around the JSON, grab the outermost
  // {...} or [...] span instead of assuming the whole string is JSON.
  const firstBrace = cleaned.search(/[{[]/);
  if (firstBrace > 0) {
    cleaned = cleaned.slice(firstBrace);
  }
  return JSON.parse(cleaned);
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

Respond with ONLY a JSON array (no prose, no markdown fences) in exactly this shape:
[
  {
    "id": "kebab-case-unique-id",
    "name": "...",
    "house": "...",
    "price": "~$XX",
    "tier": "affordable" | "mid" | "luxury",
    "tags": ["2-4 notes or descriptors"],
    "dupe": false,
    "dupeOf": null,
    "reason": "one sentence, specific to their actual collection above"
  }
]`;

      let suggestions;
      try {
        const raw = await callClaude(prompt, 2200);
        suggestions = extractJson(raw);
        if (!Array.isArray(suggestions)) throw new Error("Response was not an array");
      } catch (err) {
        console.error("refreshSuggestions: failed to get/parse suggestions", err);
        return;
      }

      await db.ref("/suggestions").set(suggestions);
      await db.ref("/suggestionsMeta").set({refreshedAt: Date.now()});
      console.log(`refreshSuggestions: wrote ${suggestions.length} suggestions`);
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

Respond with ONLY this JSON (no prose, no markdown fences):
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

        const raw = await callClaude(prompt, 2200);
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
    {secrets: [ANTHROPIC_API_KEY], cors: true},
    async (req, res) => {
      const q = (req.query.q || (req.body && req.body.q) || "").toString().trim();
      if (!q) {
        res.status(400).json({found: false, error: "missing query"});
        return;
      }

      const prompt = `Identify the real, released fragrance that best matches this
search: "${q}".

If you confidently recognize a specific real fragrance, respond with ONLY this
JSON (no prose, no markdown fences):
{"found":true,"name":"...","house":"...","tags":["3-5 top notes/accords"],"price":"approx retail like ~$85","reason":"one sentence describing its character"}

If you don't confidently recognize a specific fragrance, respond with ONLY:
{"found":false}`;

      try {
        const raw = await callClaude(prompt, 400);
        const parsed = extractJson(raw);
        res.json(parsed);
      } catch (err) {
        console.error("lookupFragrance error", err);
        res.status(500).json({found: false, error: "lookup failed"});
      }
    },
);
