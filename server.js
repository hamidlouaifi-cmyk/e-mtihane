/**
 * ═══════════════════════════════════════════════════
 *  e-mtihane Backend — server.js
 *  Routes :
 *    POST /api/correct     → Correction IA d'un exercice
 *    POST /api/parse-pdf   → Lecture et extraction d'un PDF
 *    POST /api/grade-exam  → Correction complète d'un examen
 *    GET  /api/health      → Vérification que le serveur tourne
 * ═══════════════════════════════════════════════════
 */

require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const multer  = require("multer");
const Anthropic = require("@anthropic-ai/sdk");
const pdfParse  = require("pdf-parse");

const app  = express();
const port = process.env.PORT || 3001;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Middlewares ──────────────────────────────────────
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json({ limit: "10mb" }));

// Upload PDF en mémoire (pas sur disque)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 }, // 20 MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Seuls les fichiers PDF sont acceptés"));
  },
});

// ── GET /api/health ──────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "e-mtihane backend",
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    timestamp: new Date().toISOString(),
  });
});

// ── POST /api/correct ────────────────────────────────
/**
 * Correction IA d'un exercice unique
 * Body : { exercice, reponseEleve, corrige, bareme, langue? }
 * Retourne : { note, max, feedback, points_forts, lacunes, orientations }
 */
app.post("/api/correct", async (req, res) => {
  const { exercice, reponseEleve, corrige, bareme, langue = "ar" } = req.body;

  if (!exercice || !corrige || bareme === undefined) {
    return res.status(400).json({ error: "Champs manquants: exercice, corrige, bareme" });
  }

  const isArabic = langue === "ar";
  const hasAnswer = !!(reponseEleve && reponseEleve.trim());

  if (!hasAnswer) {
    return res.json({
      note: 0, max: bareme,
      feedback: isArabic ? "لم يتم تقديم أي إجابة." : "Aucune réponse fournie.",
      points_forts: [],
      lacunes: [isArabic ? "لم يُعالج التمرين" : "Exercice non traité"],
      orientations: [isArabic ? "راجع الدرس وأعد المحاولة" : "Révisez le cours et retentez"],
    });
  }

  const prompt = isArabic
    ? buildPromptArabic(exercice, reponseEleve, corrige, bareme)
    : buildPromptFrench(exercice, reponseEleve, corrige, bareme);

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("")
      .trim();

    // Extraire le JSON de la réponse
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("JSON introuvable dans la réponse IA");

    const result = JSON.parse(match[0]);
    result.note = Math.max(0, Math.min(Number(result.note) || 0, bareme));

    return res.json({ ...result, max: bareme, provider: "claude" });

  } catch (err) {
    console.error("Erreur correction IA:", err.message);
    return res.status(500).json({
      error: err.message,
      note: Math.round(bareme * 0.3),
      max: bareme,
      feedback: isArabic ? "حدث خطأ في التصحيح التلقائي." : "Erreur lors de la correction automatique.",
      points_forts: [],
      lacunes: [isArabic ? "تعذّر التصحيح" : "Correction impossible"],
      orientations: [],
      provider: "error",
    });
  }
});

// ── POST /api/grade-exam ─────────────────────────────
/**
 * Correction complète d'un examen (tous les exercices)
 * Body : { exercises: [{id, title, content, points}], answers: {ex_1: "...", ex_2: "..."}, solutions: {ex1: "...", ex2: "..."}, langue? }
 */
app.post("/api/grade-exam", async (req, res) => {
  const { exercises, answers, solutions, langue = "ar" } = req.body;

  if (!exercises || !answers || !solutions) {
    return res.status(400).json({ error: "Champs manquants: exercises, answers, solutions" });
  }

  try {
    const results = [];

    for (const ex of exercises) {
      const answer   = answers[`ex_${ex.id}`] || "";
      const solution = solutions[`ex${ex.id}`] || "";

      const isArabic = langue === "ar";
      const hasAnswer = !!(answer && answer.trim());

      let result;

      if (!hasAnswer) {
        result = {
          note: 0, max: ex.points,
          feedback: isArabic ? "لم يتم تقديم أي إجابة." : "Aucune réponse.",
          points_forts: [],
          lacunes: [isArabic ? "لم يُعالج" : "Non traité"],
          orientations: [],
          provider: "local",
        };
      } else {
        const prompt = isArabic
          ? buildPromptArabic(ex.content, answer, solution, ex.points)
          : buildPromptFrench(ex.content, answer, solution, ex.points);

        const message = await anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 900,
          messages: [{ role: "user", content: prompt }],
        });

        const text = message.content.filter(b=>b.type==="text").map(b=>b.text).join("").trim();
        const match = text.match(/\{[\s\S]*\}/);

        if (match) {
          const parsed = JSON.parse(match[0]);
          parsed.note = Math.max(0, Math.min(Number(parsed.note)||0, ex.points));
          result = { ...parsed, max: ex.points, provider: "claude" };
        } else {
          throw new Error("JSON introuvable");
        }
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
/**
 * Extraction du contenu d'un PDF et structuration par l'IA
 * Form-data : file (PDF), type ("subject" | "solution"), langue?
 * Retourne : { title, exercises: [{id, title, content, points}] }
 *        ou : { solutions: {ex1: "...", ex2: "..."} }
 */
app.post("/api/parse-pdf", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Aucun fichier PDF reçu" });
  }

  const type   = req.body.type   || "subject";  // "subject" ou "solution"
  const langue = req.body.langue || "ar";

  try {
    // 1. Extraire le texte brut du PDF
    const pdfData = await pdfParse(req.file.buffer);
    const rawText = pdfData.text.trim();

    if (!rawText || rawText.length < 20) {
      return res.status(422).json({ error: "PDF vide ou non lisible (PDF scanné ?)" });
    }

    // 2. Demander à Claude de structurer le contenu
    const prompt = type === "subject"
      ? buildPdfSubjectPrompt(rawText, langue)
      : buildPdfSolutionPrompt(rawText, langue);

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 3000,
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content.filter(b=>b.type==="text").map(b=>b.text).join("").trim();
    const match = text.match(/\{[\s\S]*\}/);

    if (!match) throw new Error("Structure non détectée dans le PDF");

    const structured = JSON.parse(match[0]);
    return res.json({ ...structured, pages: pdfData.numpages, rawLength: rawText.length });

  } catch (err) {
    console.error("Erreur parse-pdf:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── PROMPTS ──────────────────────────────────────────

function buildPromptArabic(exercice, reponse, corrige, bareme) {
  return `أنت أستاذ مصحح خبير في الرياضيات لامتحان البكالوريا الجزائرية (ديوان الوطني للامتحانات والمسابقات).

التمرين (${bareme} نقاط):
${exercice}

التصحيح الرسمي (سري - للمقارنة فقط، لا تعيد ذكره):
${corrige}

إجابة التلميذ:
${reponse.trim()}

صحّح إجابة التلميذ مقارنةً بالتصحيح الرسمي. قيّم:
- هل فهم التلميذ المطلوب؟
- هل طبّق المنهجية الصحيحة؟
- ما هي الأخطاء المفاهيمية أو الحسابية؟
- ما هي الخطوات الناقصة؟

قواعد التنقيط:
- النقطة من 0 إلى ${bareme} بخطوة 0.5
- قاعدة الخطأ المتسلسل: إذا أدى خطأ أولي إلى أخطاء متتالية منطقية، خصم عقوبة واحدة فقط
- كن عادلاً وصارماً مثل مصحح بكالوريا حقيقي

أجب بـ JSON صحيح فقط على سطر واحد، بدون markdown:
{"note":0,"max":${bareme},"feedback":"تحليل تفصيلي 2-3 جمل بالعربية","points_forts":["نقطة إيجابية 1"],"lacunes":["ثغرة محددة 1","ثغرة محددة 2"],"orientations":["كيف يتحسن 1","كيف يتحسن 2"]}`;
}

function buildPromptFrench(exercice, reponse, corrige, bareme) {
  return `Tu es un correcteur expert du baccalauréat algérien (ONEC) en mathématiques.

Exercice (${bareme} points) :
${exercice}

Corrigé officiel (confidentiel - pour comparaison uniquement, ne pas reproduire) :
${corrige}

Réponse de l'élève :
${reponse.trim()}

Corrige la réponse de l'élève en la comparant au corrigé officiel. Évalue :
- La compréhension du problème
- La démarche méthodologique
- Les erreurs conceptuelles ou de calcul
- Les étapes manquantes

Règles :
- Note de 0 à ${bareme} par pas de 0.5
- Applique la règle de l'erreur entraînée (une seule pénalité si l'erreur initiale est cohérente)
- Sois juste et rigoureux comme un vrai correcteur du bac

Réponds avec un JSON valide sur une ligne, sans markdown :
{"note":0,"max":${bareme},"feedback":"analyse 2-3 phrases","points_forts":["point positif"],"lacunes":["lacune précise 1","lacune précise 2"],"orientations":["conseil 1","conseil 2"]}`;
}

function buildPdfSubjectPrompt(rawText, langue) {
  const isAr = langue === "ar";
  return `${isAr ? "أنت خبير في تحليل مواضيع البكالوريا الجزائرية." : "Tu es expert en analyse de sujets du baccalauréat algérien."}

${isAr ? "النص المستخرج من PDF:" : "Texte extrait du PDF :"}
${rawText.slice(0, 6000)}

${isAr
  ? "حلّل هذا النص واستخرج بنية الموضوع. أجب بـ JSON فقط بدون markdown:"
  : "Analyse ce texte et extrais la structure du sujet. Réponds en JSON uniquement sans markdown :"}

{
  "title": "${isAr ? "عنوان الموضوع" : "titre du sujet"}",
  "subject": "${isAr ? "المادة" : "matière"}",
  "session": "${isAr ? "الدورة والسنة" : "session et année"}",
  "duration": 180,
  "exercises": [
    {
      "id": 1,
      "title": "${isAr ? "عنوان التمرين 1" : "titre exercice 1"}",
      "points": 6,
      "content": "${isAr ? "نص التمرين كاملاً مع جميع الأسئلة" : "texte complet de l'exercice avec toutes les questions"}"
    }
  ]
}

${isAr
  ? "مهم: استخرج نص التمارين كاملاً بدون تغيير. احتفظ بالأرقام والرموز الرياضية كما هي."
  : "Important: extrais le texte complet des exercices sans modification. Conserve les formules mathématiques."}`;
}

function buildPdfSolutionPrompt(rawText, langue) {
  const isAr = langue === "ar";
  return `${isAr ? "أنت خبير في تحليل تصاحيح البكالوريا الجزائرية." : "Tu es expert en analyse de corrigés du baccalauréat algérien."}

${isAr ? "النص المستخرج من PDF التصحيح:" : "Texte extrait du PDF corrigé :"}
${rawText.slice(0, 8000)}

${isAr
  ? "استخرج التصحيح لكل تمرين. أجب بـ JSON فقط بدون markdown:"
  : "Extrais le corrigé de chaque exercice. Réponds en JSON uniquement sans markdown :"}

{
  "solutions": {
    "ex1": "${isAr ? "التصحيح الكامل للتمرين 1 مع الخطوات والنتائج" : "corrigé complet exercice 1 avec étapes et résultats"}",
    "ex2": "${isAr ? "التصحيح الكامل للتمرين 2" : "corrigé complet exercice 2"}",
    "ex3": "${isAr ? "التصحيح الكامل للتمرين 3" : "corrigé complet exercice 3"}"
  },
  "bareme": {
    "ex1": 6,
    "ex2": 7,
    "ex3": 7
  }
}

${isAr
  ? "مهم: احتفظ بجميع خطوات الحل والنتائج العددية الدقيقة."
  : "Important: conservez toutes les étapes de résolution et les résultats numériques exacts."}`;
}

// ── Démarrage ────────────────────────────────────────
app.listen(port, () => {
  console.log(`
╔════════════════════════════════════════╗
║     e-mtihane Backend — Démarré        ║
╠════════════════════════════════════════╣
║  Port    : ${port}                          ║
║  Clé API : ${process.env.ANTHROPIC_API_KEY ? "✓ Configurée" : "✗ MANQUANTE !"}         ║
╚════════════════════════════════════════╝

Routes disponibles :
  GET  /api/health
  POST /api/correct
  POST /api/grade-exam
  POST /api/parse-pdf
`);
});

module.exports = app;
