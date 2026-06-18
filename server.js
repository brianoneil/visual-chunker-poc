import express from 'express';
import multer from 'multer';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed'));
  }
});

app.use(express.static(path.join(__dirname, 'public')));

const REGION_PROMPT = `Analyze this document page image and detect all layout regions.
Return ONLY a JSON array (no markdown, no explanation) where each element has:
- "type": one of: title, header, paragraph, table, figure, caption, list, footer, sidebar
- "label": brief description (e.g. "Section Header", "Data Table", "Body Text")
- "bbox": { "x": %, "y": %, "w": %, "h": % } — percentage of page width/height (0-100)

Be precise with bounding boxes. Cover all meaningful regions. Return valid JSON only.`;

async function detectRegions(imageBase64, model) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://visual-chunker-poc.lotsgoingon.com',
      'X-Title': 'Visual Chunker POC'
    },
    body: JSON.stringify({
      model: model || process.env.VISION_MODEL || 'google/gemini-flash-1.5',
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
          { type: 'text', text: REGION_PROMPT }
        ]
      }],
      max_tokens: 2000
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '';

  // Robust JSON extraction
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error(`No JSON array in response: ${text.slice(0, 200)}`);
  return JSON.parse(jsonMatch[0]);
}

app.post('/analyze', upload.single('pdf'), async (req, res) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-'));
  const pdfPath = req.file?.path;

  try {
    if (!pdfPath) return res.status(400).json({ error: 'No PDF uploaded' });

    const model = req.body.model || process.env.VISION_MODEL || 'google/gemini-flash-1.5';
    const outputPrefix = path.join(tmpDir, 'page');

    // Render PDF pages to PNG
    try {
      execSync(`pdftoppm -r 120 -png "${pdfPath}" "${outputPrefix}"`, { timeout: 60000 });
    } catch (e) {
      return res.status(500).json({ error: 'Failed to render PDF. Is poppler-utils installed?' });
    }

    // Collect rendered page files
    const pageFiles = fs.readdirSync(tmpDir)
      .filter(f => f.endsWith('.png'))
      .sort()
      .map(f => path.join(tmpDir, f));

    if (pageFiles.length === 0) {
      return res.status(500).json({ error: 'No pages rendered from PDF' });
    }

    // Process pages in batches of 3
    const results = [];
    const BATCH = 3;
    for (let i = 0; i < pageFiles.length; i += BATCH) {
      const batch = pageFiles.slice(i, i + BATCH);
      const batchResults = await Promise.all(batch.map(async (pageFile, idx) => {
        const pageNum = i + idx + 1;
        try {
          const imageData = fs.readFileSync(pageFile);
          const imageBase64 = imageData.toString('base64');
          const regions = await detectRegions(imageBase64, model);
          return { page: pageNum, imageBase64, regions, error: null };
        } catch (e) {
          return { page: pageNum, imageBase64: null, regions: [], error: e.message };
        }
      }));
      results.push(...batchResults);
    }

    res.json({ pages: results, model });
  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    // Cleanup
    if (pdfPath) try { fs.unlinkSync(pdfPath); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

app.listen(PORT, () => {
  console.log(`Visual Chunker POC running on port ${PORT}`);
});
