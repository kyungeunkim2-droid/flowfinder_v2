import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

// FlowFinder Nano Banana preview server
// 1) npm install
// 2) copy .env.example to .env and set GEMINI_API_KEY
// 3) npm run dev

dotenv.config();
if (!process.env.GEMINI_API_KEY && process.env.GOOGLE_API_KEY) process.env.GEMINI_API_KEY = process.env.GOOGLE_API_KEY;
if (!process.env.GEMINI_API_KEY && process.env.GOOGLE_GENERATIVE_AI_API_KEY) process.env.GEMINI_API_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image-preview';

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname, {
  etag: true,
  maxAge: '1h',
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});


app.get('/api/health', (req, res) => {
  res.json({ ok: true, hasGeminiKey: Boolean(process.env.GEMINI_API_KEY), model: MODEL });
});

function assertSafeUrl(raw, baseUrl) {
  if (!raw || typeof raw !== 'string') return null;
  const url = raw.trim();
  if (url.startsWith('data:')) return null;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return new URL(url, baseUrl).toString();
}

function dataUrlToImagePart(src) {
  if (!src || typeof src !== 'string') return null;
  const match = src.trim().match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) return null;
  return {
    inlineData: {
      mimeType: match[1] || 'image/png',
      data: match[2].replace(/\s/g, ''),
    },
  };
}

async function loadImagePart(src, label, baseUrl) {
  const dataPart = dataUrlToImagePart(src);
  if (dataPart) return dataPart;

  const safeUrl = assertSafeUrl(src, baseUrl);
  if (!safeUrl) return null;
  const response = await fetch(safeUrl);
  if (!response.ok) throw new Error(`이미지 로드 실패: ${label || src}`);
  const mimeType = response.headers.get('content-type')?.split(';')[0] || 'image/png';
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    inlineData: {
      mimeType,
      data: bytes.toString('base64'),
    },
  };
}

function extractInlineImage(response) {
  const candidates = response?.candidates || [];
  for (const candidate of candidates) {
    const partsOut = candidate?.content?.parts || [];
    for (const part of partsOut) {
      const inline = part?.inlineData || part?.inline_data || part?.inline_data_content || null;
      if (inline?.data) {
        return {
          data: inline.data,
          mimeType: inline.mimeType || inline.mime_type || 'image/png',
        };
      }
    }
  }
  return null;
}

function extractText(response) {
  const candidates = response?.candidates || [];
  return candidates
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part?.text)
    .filter(Boolean)
    .join('\n');
}

app.post('/api/generate-preview', async (req, res) => {
  console.log('[NanoBanana] /api/generate-preview called');
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: 'GEMINI_API_KEY가 설정되지 않았습니다. .env 파일을 확인해주세요.',
      });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}/`;

 const {
  deskImage,
  topTexture,
  legTexture,
  topCode,
  legCode,
  deskLabel,
  legType,
  casterType,
  topShape,
  size,
} = req.body || {};

    const parts = [];
   parts.push({
  text: [
    'Use the base furniture product image as the exact reference.',
    'Keep the same camera angle, perspective, proportions, silhouette, dimensions, background, and lighting.',
    'Apply the provided top material texture naturally only to the desktop surface.',
    'Apply the provided leg material color naturally only to the desk legs and frame.',
    'Do not redraw the product.',
    'Do not add a screen panel.',
    'Do not show masks, outlines, guide lines, pen-tool paths, or overlay marks.',
    'Create a photorealistic office furniture catalog render.'
  ].join('\n')
});

 const imageInputs = [
  ['base furniture product image', deskImage],
  ['desktop material texture reference', topTexture],
  ['legs and frame material color reference', legTexture],
];

for (const [label, src] of imageInputs) {
  const part = await loadImagePart(src, label, baseUrl).catch((err) => {
    console.warn(err.message);
    return null;
  });

  if (part) {
    parts.push(part);
  }
}

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const modelCandidates = Array.from(new Set([
      MODEL,
      'gemini-2.5-flash-image-preview',
      'gemini-3-pro-image-preview',
    ].filter(Boolean)));

    let lastText = '';
    let lastModel = '';

    for (const model of modelCandidates) {
      lastModel = model;
      console.log(`[NanoBanana] trying model: ${model}`);

      const response = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: { responseModalities: ['TEXT', 'IMAGE'] },
      });

      const inline = extractInlineImage(response);
      if (inline?.data) {
        return res.json({ imageUrl: `data:${inline.mimeType};base64,${inline.data}` });
      }

      lastText = extractText(response);
      console.warn('[NanoBanana] no inline image returned', {
        model,
        text: lastText?.slice(0, 800),
      });
    }

    return res.status(500).json({
      error: '이미지 결과를 받지 못했습니다.',
      detail: lastText || 'Gemini 응답에 inline image data가 없습니다.',
      model: lastModel,
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || '이미지 생성 실패', hint: 'GEMINI_API_KEY, 모델명, Render 환경변수, 이미지 경로(products/textures), 서버 로그를 확인하세요.' });
  }
});

app.listen(PORT, () => {
  console.log(`FlowFinder preview server running: http://localhost:${PORT}`);
});
