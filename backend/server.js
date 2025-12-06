import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import FormData from "form-data";  // IMPORTANT for multipart uploads
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// ===================== API KEYS =====================
const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent";

const GEMINI_KEY = process.env.GEMINI_KEY;
const STABILITY_KEY = process.env.STABILITY_KEY;
const PORT = process.env.PORT || 5000;

if (!GEMINI_KEY) console.warn("⚠️ Warning: No GEMINI_KEY found in .env file.");
if (!STABILITY_KEY) console.warn("⚠️ Warning: No STABILITY_KEY found in .env file.");


// ===================== GEMINI TEXT GENERATION =====================
async function callGemini(prompt) {
  const url = `${GEMINI_API_URL}?key=${GEMINI_KEY}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: prompt }],
        },
      ],
    }),
  });

  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`Gemini API error: ${res.status} — ${msg}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}


// ===================== PANEL TEXT PARSING =====================
function parsePanelsFromModelOutput(outputText, numPanels, originalStory) {
  if (!outputText || !outputText.trim()) {
    return fallbackSplit(originalStory, numPanels);
  }

  const lines = outputText
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const panelRegex = /^Panel\s*\d+\s*[:.-]?\s*(.+)$/i;

  const extracted = lines
    .map((line) => {
      const match = line.match(panelRegex);
      return match ? match[1].trim() : null;
    })
    .filter(Boolean);

  if (extracted.length >= numPanels) return extracted.slice(0, numPanels);

  return fallbackSplit(originalStory, numPanels);
}


// ===================== FALLBACK PANEL SPLITTER =====================
function fallbackSplit(text, numPanels) {
  const sentences = text
    .replace(/\n/g, " ")
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunk = Math.ceil(sentences.length / numPanels);
  return Array.from({ length: numPanels }, (_, i) =>
    sentences.slice(i * chunk, (i + 1) * chunk).join(" ")
  );
}


// ===================== ROUTE 1 — GENERATE TEXT PANELS =====================
app.post("/api/generate-panels", async (req, res) => {
  try {
    const { story, numPanels } = req.body;

    if (!story?.trim()) {
      return res.status(400).json({ error: "Story is required." });
    }

    const prompt = `
Break the following story into ${numPanels} comic panels.
Write short, visual, cinematic descriptions.

Panel 1:
Panel 2:
...
Panel ${numPanels}:

Story:
"${story}"
`;

    const output = await callGemini(prompt);
    const panels = parsePanelsFromModelOutput(output, numPanels, story);

    console.log("\n=== Generated Panels ===");
    panels.forEach((p, i) => console.log(`Panel ${i + 1}: ${p}`));
    console.log("========================\n");

    res.json({ panels });
  } catch (err) {
    console.error("❌ Panel Generation Error:", err);
    res.status(500).json({ error: err.message });
  }
});


// ===================== STABILITY IMAGE GENERATION =====================
async function generateImageFromPanel(promptText) {
  const formData = new FormData();

  formData.append("prompt", `comic-style illustration: ${promptText}`);
  formData.append("model", "sd3");
  formData.append("output_format", "png");

  const res = await fetch(
    "https://api.stability.ai/v2beta/stable-image/generate/core",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STABILITY_KEY}`,
        Accept: "image/*",
        ...formData.getHeaders(),
      },
      body: formData,
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Stability Image Error: ${res.status} — ${errText}`);
  }

  const buffer = await res.arrayBuffer();
  return `data:image/png;base64,${Buffer.from(buffer).toString("base64")}`;
}


// ===================== ROUTE 2 — GENERATE IMAGES FOR PANELS =====================
app.post("/api/generate-images", async (req, res) => {
  try {
    const { panels } = req.body;

    if (!Array.isArray(panels)) {
      return res.status(400).json({ error: "Panels array required." });
    }

    const images = [];

    for (let i = 0; i < panels.length; i++) {
      console.log(`🎨 Generating image for Panel ${i + 1}...`);
      const img = await generateImageFromPanel(panels[i] || "comic scene");
      images.push(img);
    }

    res.json({ images });
  } catch (err) {
    console.error("❌ Image Generation Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===================== ROUTE 3: EXPORT COMIC TO PDF =====================

app.post("/api/export-pdf", async (req, res) => {
  try {
    const { panels, images } = req.body;

    if (!panels || !images) {
      return res
        .status(400)
        .json({ error: "Panels and images are required for PDF export." });
    }

    // Temporary file path
    const filePath = path.join(process.cwd(), "comic.pdf");

    const doc = new PDFDocument({ autoFirstPage: false });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Loop through panels
    for (let i = 0; i < panels.length; i++) {
      const caption = panels[i];
      const base64Img = images[i]?.replace(/^data:image\/png;base64,/, "");

      // Add a new page for each panel
      doc.addPage({ margin: 40 });

      // Image
      if (base64Img) {
        const imgBuffer = Buffer.from(base64Img, "base64");
        doc.image(imgBuffer, { fit: [500, 300], align: "center" });
      }

      // Caption text
      doc.moveDown();
      doc.fontSize(14).text(caption, { align: "center" });
    }

    doc.end();

    stream.on("finish", () => {
      // Send the file to frontend
      res.download(filePath, "comic.pdf", (err) => {
        if (err) console.error("❌ PDF download error", err);

        fs.unlinkSync(filePath); // Delete file after sending
      });
    });
  } catch (err) {
    console.error("❌ PDF Export Error:", err);
    res.status(500).json({ error: err.message });
  }
});


// ===================== START SERVER =====================
app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
