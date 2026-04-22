/**
 * ═══════════════════════════════════════════════════
 *  e-mtihane Backend — server.js (DeepSeek)
 *  Remplace Anthropic par DeepSeek (~95% moins cher)
 *  Clé API : https://platform.deepseek.com
 * ═══════════════════════════════════════════════════
 */

require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const multer   = require("multer");
const pdfParse = require("pdf-parse");
const https    = require("https");

const app  = express();
const port = process.env.PORT || 3001;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// ── Middlewares ──────────────────────────────────────
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json({ limit: "10mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Seuls les fichiers PDF sont acceptés"));
  },
});

// ── Fonction appel DeepSeek ──────────────────────────
async function callDeepSeek(prompt, maxTokens = 1000) {
  const body = JSON.stringify({
    model: "deepseek-chat",
    max_tokens: maxTokens,
    temperature: 0.1,
    messages: [{ role: "user", content: prompt }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.deepseek.com",
      path:     "/v1/chat/completions",
      method:   "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message || "DeepSeek error"));
          const text = json.choices?.[0]?.message?.content || "";
          resolve(text.trim());
        } catch(e) {
          reject(new Error("Réponse DeepSeek invalide: " + data.slice(0,200)));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Extraire JSON de la réponse ──────────────────────
function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("JSON introuvable dans la réponse");
  return JSON.parse(match[0]);
}

// ── GET /api/health ──────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status:   "ok",
    service:  "e-mtihane backend (DeepSeek)",
    deepseek: !!DEEPSEEK_API_KEY,
    // On garde "anthropic" pour compatibilité avec le frontend
    anthropic: !!DEEPSEEK_API_KEY,
    timestamp: new Date().toISOString(),
  });
});

// ── POST /api/correct ────────────────────────────────
app.post("/api/correct", async (req, res) => {
  const { exercice, reponseEleve, corrige, bareme, langue = "ar" } = req.body;

  if (!exercice || !corrige || bareme === undefined) {
    return res.status(400).json({ error: "Champs manquants: exercice, corrige, bareme" });
  }

  const isArabic  = langue === "ar";
  const hasAnswer = !!(reponseEleve && reponseEleve.trim());

  if (!hasAnswer) {
    return res.json({
      note: 0, max: bareme,
      feedback: isArabic ? "لم يتم تقديم أي إجابة." : "Aucune réponse fournie.",
      points_forts: [],
      lacunes:      [isArabic ? "لم يُعالج التمرين" : "Exercice non traité"],
      orientations: [isArabic ? "راجع الدرس وأعد المحاولة" : "Révisez le cours et retentez"],
    });
  }

  const prompt = isArabic
    ? buildPromptArabic(exercice, reponseEleve, corrige, bareme)
    : buildPromptFrench(exercice, reponseEleve, corrige, bareme);

  try {
    const text   = await callDeepSeek(prompt, 1000);
    const result = extractJSON(text);
    result.note  = Math.max(0, Math.min(Number(result.note) || 0, bareme));
    return res.json({ ...result, max: bareme, provider: "deepseek" });
  } catch (err) {
    console.error("Erreur correction:", err.message);
    return res.status(500).json({
      error: err.message,
      note: Math.round(bareme * 0.3), max: bareme,
      feedback: isArabic ? "حدث خطأ في التصحيح." : "Erreur de correction.",
      points_forts: [], lacunes: [], orientations: [],
      provider: "error",
    });
  }
});

// ── POST /api/grade-exam ─────────────────────────────
app.post("/api/grade-exam", async (req, res) => {
  const { exercises, answers, solutions, langue = "ar" } = req.body;

  if (!exercises || !answers || !solutions) {
    return res.status(400).json({ error: "Champs manquants" });
  }

  const isArabic = langue === "ar";

  try {
    const results = [];

    for (const ex of exercises) {
      const answer   = answers[`ex_${ex.id}`] || "";
      const solution = solutions[`ex${ex.id}`] || "";
      const hasAnswer = !!(answer && answer.trim());

      let result;

      if (!hasAnswer) {
        result = {
          note: 0, max: ex.points,
          feedback:     isArabic ? "لم يتم تقديم أي إجابة." : "Aucune réponse.",
          points_forts: [],
          lacunes:      [isArabic ? "لم يُعالج" : "Non traité"],
          orientations: [],
          provider: "local",
        };
      } else {
        const prompt = isArabic
          ? buildPromptArabic(ex.content, answer, solution, ex.points)
          : buildPromptFrench(ex.content, answer, solution, ex.points);

        const text   = await callDeepSeek(prompt, 900);
        const parsed = extractJSON(text);
        parsed.note  = Math.max(0, Math.min(Number(parsed.note) || 0, ex.points));
        result = { ...parsed, max: ex.points, provider: "deepseek" };
      }

      results.push({ ...result, exId: ex.id, exTitle: ex.title });
    }

    const totalPoints = results.reduce((s, r) => s + r.note, 0);
    const maxPoints   = exercises.reduce((s, e) => s + e.points, 0);
    const noteOn20    = Math.round((totalPoints / maxPoints) * 200) / 10;

    return res.json({ exercises: results, totalPoints, maxPoints, noteOn20 });

  } catch (err) {
    console.error("Erreur grade-exam:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/parse-pdf ──────────────────────────────
app.post("/api/parse-pdf", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Aucun fichier PDF reçu" });
  }

  const type   = req.body.type   || "subject";
  const langue = req.body.langue || "ar";

  try {
    const pdfData = await pdfParse(req.file.buffer);
    const rawText = pdfData.text.trim();

    if (!rawText || rawText.length < 20) {
      return res.status(422).json({ error: "PDF vide ou non lisible" });
    }

    const prompt = type === "subject"
      ? buildPdfSubjectPrompt(rawText, langue)
      : buildPdfSolutionPrompt(rawText, langue);

    const text      = await callDeepSeek(prompt, 3000);
    const structured = extractJSON(text);

    return res.json({ ...structured, pages: pdfData.numpages });

  } catch (err) {
    console.error("Erreur parse-pdf:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── PROMPTS ──────────────────────────────────────────

function buildPromptArabic(exercice, reponse, corrige, bareme) {
  return `أنت أستاذ مصحح خبير في الرياضيات لامتحان البكالوريا الجزائرية (ONEC).

التمرين (${bareme} نقاط):
${exercice}

التصحيح الرسمي (سري - للمقارنة فقط، لا تعيد ذكره):
${corrige}

إجابة التلميذ:
${reponse.trim()}

صحّح بدقة مقارنةً بالتصحيح الرسمي.

قواعد:
- النقطة من 0 إلى ${bareme} بخطوة 0.5
- قاعدة الخطأ المتسلسل: خطأ أولي منطقي = عقوبة واحدة فقط
- كن عادلاً وصارماً

أجب بـ JSON على سطر واحد بدون markdown:
{"note":0,"max":${bareme},"feedback":"تحليل 2-3 جمل","points_forts":["..."],"lacunes":["خطأ 1","خطأ 2"],"orientations":["نصيحة 1","نصيحة 2"]}`;
}

function buildPromptFrench(exercice, reponse, corrige, bareme) {
  return `Tu es correcteur expert du baccalauréat algérien (ONEC) en mathématiques.

Exercice (${bareme} points) :
${exercice}

Corrigé officiel (confidentiel) :
${corrige}

Réponse de l'élève :
${reponse.trim()}

Règles: note 0-${bareme} par 0.5, erreur entraînée = pénalité unique.

JSON sur une ligne sans markdown:
{"note":0,"max":${bareme},"feedback":"analyse","points_forts":["..."],"lacunes":["..."],"orientations":["..."]}`;
}

function buildPdfSubjectPrompt(rawText, langue) {
  const isAr = langue === "ar";
  return `${isAr?"حلّل موضوع البكالوريا واستخرج بنيته.":"Analyse ce sujet de bac et extrais sa structure."}

${rawText.slice(0, 6000)}

JSON sans markdown:
{"title":"...","subject":"...","session":"...","duration":180,"exercises":[{"id":1,"title":"...","points":6,"content":"نص التمرين كاملاً"}]}`;
}

function buildPdfSolutionPrompt(rawText, langue) {
  return `استخرج التصحيح لكل تمرين.

${rawText.slice(0, 8000)}

JSON sans markdown:
{"solutions":{"ex1":"التصحيح الكامل","ex2":"...","ex3":"..."},"bareme":{"ex1":6,"ex2":7,"ex3":7}}`;
}

// ── Démarrage ────────────────────────────────────────
app.listen(port, () => {
  console.log(`
╔════════════════════════════════════════╗
║     e-mtihane Backend — DeepSeek       ║
╠════════════════════════════════════════╣
║  Port     : ${port}                         ║
║  Clé API  : ${DEEPSEEK_API_KEY ? "✓ Configurée" : "✗ MANQUANTE !"}        ║
╚════════════════════════════════════════╝

Routes disponibles :
  GET  /api/health
  POST /api/correct
  POST /api/grade-exam
  POST /api/parse-pdf
`);
});

module.exports = app;
