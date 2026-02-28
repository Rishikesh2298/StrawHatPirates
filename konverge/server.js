const express = require('express');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/', limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const SERP_API_KEY    = 'e7ea59f9330c9708a3ccb9f8366d47ea8cf564da87d6ff5dd9505ff09b7cb836';
const SAPLING_API_KEY = process.env.SAPLING_API_KEY || '4B97BV3T70R6NZA277TPB2ZEL4N8NLPX';

// ─── SAPLING AI DETECTION ─────────────────────────────────────────────────────
async function callSaplingAI(text) {
  if (!SAPLING_API_KEY) return null;
  try {
    const res = await axios.post(
      'https://api.sapling.ai/api/v1/aidetect',
      { key: SAPLING_API_KEY, text },
      { timeout: 10000 }
    );
    // score: 0 = human, 1 = AI
    const score = res.data?.score;
    return typeof score === 'number' ? score : null;
  } catch (e) {
    console.error('Sapling AI:', e.message);
    return null;
  }
}

// ─── HEURISTIC TEXT DETECTION ─────────────────────────────────────────────────
function analyzeTextHeuristics(text) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || text.split('\n').filter(Boolean);
  const words = text.toLowerCase().match(/\b[a-z']+\b/g) || [];
  const totalWords = words.length;
  if (totalWords < 10) return { score: 0.5, signals: [] };

  const signals = [];
  let aiScore = 0, totalWeight = 0;

  // 1. Sentence Length Variance
  const sentLengths = sentences.map(s => s.trim().split(/\s+/).length).filter(l => l > 2);
  if (sentLengths.length >= 3) {
    const mean = sentLengths.reduce((a, b) => a + b, 0) / sentLengths.length;
    const variance = sentLengths.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / sentLengths.length;
    const cv = Math.sqrt(variance) / mean;
    const w = 0.22, s = cv < 0.15 ? 0.90 : cv < 0.25 ? 0.70 : cv < 0.40 ? 0.45 : 0.20;
    aiScore += s * w; totalWeight += w;
    signals.push({ name: 'Sentence Uniformity', value: cv < 0.25 ? 'Very uniform (AI-like)' : 'Varied (human-like)', flag: cv < 0.25 ? 'ai' : 'human' });
  }

  // 2. AI Transition Phrase Density
  const aiPhrases = ['furthermore','moreover','in addition','it is worth noting','it is important to note',
    'in conclusion','to summarize','in summary','therefore','thus','additionally','notably',
    'significantly','interestingly','importantly','ultimately','in essence','overall',
    'needless to say','that being said','having said that','with that said','it can be argued',
    'it is clear that','by and large','to elaborate','in other words'];
  const lowerText = text.toLowerCase();
  const hits = aiPhrases.filter(p => lowerText.includes(p)).length;
  const phraseRate = hits / Math.max(sentLengths.length, 1);
  const w2 = 0.20, s2 = phraseRate > 0.8 ? 0.92 : phraseRate > 0.5 ? 0.78 : phraseRate > 0.25 ? 0.55 : 0.20;
  aiScore += s2 * w2; totalWeight += w2;
  signals.push({ name: 'AI Transition Phrases', value: `${hits} found (${hits > 2 ? 'high' : hits > 0 ? 'moderate' : 'none'})`, flag: hits > 2 ? 'ai' : hits > 0 ? 'uncertain' : 'human' });

  // 3. Vocabulary Richness (TTR)
  const ttr = new Set(words).size / totalWords;
  const adjTtr = totalWords > 200 ? ttr * (1 + Math.log10(totalWords / 200) * 0.3) : ttr;
  const w3 = 0.18, s3 = adjTtr < 0.40 ? 0.85 : adjTtr < 0.55 ? 0.55 : adjTtr < 0.70 ? 0.35 : 0.15;
  aiScore += s3 * w3; totalWeight += w3;
  signals.push({ name: 'Vocabulary Richness', value: `${Math.round(ttr * 100)}% unique words`, flag: adjTtr < 0.45 ? 'ai' : 'human' });

  // 4. Informal Punctuation (em-dash, ellipsis, exclamation)
  const informal = (text.match(/[—–]/g)||[]).length + (text.match(/\.\.\./, )||[]).length + (text.match(/!/g)||[]).length;
  const infRate = informal / Math.max(sentLengths.length, 1);
  const w4 = 0.14, s4 = infRate < 0.05 ? 0.80 : infRate < 0.15 ? 0.50 : infRate < 0.30 ? 0.30 : 0.10;
  aiScore += s4 * w4; totalWeight += w4;
  signals.push({ name: 'Informal Punctuation', value: informal === 0 ? 'None (AI-like)' : `${informal} instance(s)`, flag: informal === 0 ? 'ai' : 'human' });

  // 5. Lexical Burstiness
  const freq = {};
  words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });
  const freqVals = Object.values(freq).filter(c => c > 1);
  const burst = freqVals.length > 0 ? Math.max(...freqVals) / (freqVals.reduce((a,b)=>a+b,0)/freqVals.length) : 1;
  const w5 = 0.13, s5 = burst < 2.5 ? 0.75 : burst < 4 ? 0.45 : 0.20;
  aiScore += s5 * w5; totalWeight += w5;
  signals.push({ name: 'Lexical Burstiness', value: burst < 2.5 ? 'Low — evenly spread (AI-like)' : 'High — clustered (human-like)', flag: burst < 2.5 ? 'ai' : 'human' });

  // 6. Paragraph Balance
  const paras = text.split(/\n\s*\n/).filter(p => p.trim().length > 20);
  if (paras.length >= 2) {
    const pLens = paras.map(p => p.trim().split(/\s+/).length);
    const pMean = pLens.reduce((a,b)=>a+b,0)/pLens.length;
    const pCV = Math.sqrt(pLens.reduce((a,b)=>a+Math.pow(b-pMean,2),0)/pLens.length) / pMean;
    const w6 = 0.13, s6 = pCV < 0.20 ? 0.82 : pCV < 0.35 ? 0.55 : 0.20;
    aiScore += s6 * w6; totalWeight += w6;
    signals.push({ name: 'Paragraph Balance', value: pCV < 0.25 ? 'Highly balanced (AI-like)' : 'Varied lengths (human-like)', flag: pCV < 0.25 ? 'ai' : 'human' });
  }

  return { score: totalWeight > 0 ? aiScore / totalWeight : 0.5, signals };
}

// ─── HEURISTIC IMAGE DETECTION ────────────────────────────────────────────────
function analyzeImageHeuristics(buffer, mimetype) {
  const signals = [];
  let aiScore = 0, totalWeight = 0;

  const isJpeg = mimetype === 'image/jpeg' || mimetype === 'image/jpg' || (buffer[0] === 0xFF && buffer[1] === 0xD8);
  const isPng  = mimetype === 'image/png' || (buffer[0] === 0x89 && buffer[1] === 0x50);
  const sizeKb = buffer.length / 1024;
  const aiSoftwares = ['stable diffusion','dall-e','midjourney','diffusion','generative',
    'adobe firefly','leonardo','novel ai','comfyui','automatic1111','wombo','runway',
    'sd-metadata','parameters','prompt:','negative prompt','ai generated'];

  // File size signal
  const w1 = 0.10, s1 = (sizeKb > 80 && sizeKb < 6000) ? 0.55 : 0.30;
  aiScore += s1 * w1; totalWeight += w1;
  signals.push({ name: 'File Size', value: `${sizeKb.toFixed(0)} KB`, flag: 'uncertain' });

  const headerStr = buffer.slice(0, Math.min(buffer.length, 32768)).toString('latin1');
  const foundSW = aiSoftwares.find(s => headerStr.toLowerCase().includes(s));

  if (isJpeg) {
    // EXIF check
    let hasExif = false, hasCam = false;
    for (let i = 0; i < Math.min(buffer.length - 1, 65536); i++) {
      if (buffer[i] === 0xFF && buffer[i+1] === 0xE1) {
        hasExif = true;
        const chunk = buffer.slice(i+4, i+200).toString('ascii');
        if (/Canon|Nikon|Sony|Apple|Samsung|Fujifilm|Make|Model/i.test(chunk)) hasCam = true;
        break;
      }
    }
    const w2 = 0.30, s2 = !hasExif ? 0.85 : !hasCam ? 0.60 : 0.15;
    aiScore += s2 * w2; totalWeight += w2;
    signals.push({ name: 'Camera EXIF Data', value: !hasExif ? 'Missing (AI-like)' : hasCam ? 'Camera metadata present (real photo)' : 'EXIF present, no camera info', flag: !hasExif ? 'ai' : hasCam ? 'human' : 'uncertain' });

    // Software tag
    const w3 = 0.35, s3 = foundSW ? 0.95 : 0.22;
    aiScore += s3 * w3; totalWeight += w3;
    signals.push({ name: 'Software Tag', value: foundSW ? `AI tool detected: "${foundSW}"` : 'No AI software signature', flag: foundSW ? 'ai' : 'human' });

    // Entropy
    const scanStart = buffer.indexOf(0xDA, 500);
    if (scanStart > 0 && buffer.length > scanStart + 1000) {
      const sample = buffer.slice(scanStart + 2, scanStart + 1002);
      const bf = new Array(256).fill(0);
      sample.forEach(b => bf[b]++);
      const entropy = bf.reduce((sum, f) => { if (!f) return sum; const p = f/sample.length; return sum - p*Math.log2(p); }, 0);
      const w4 = 0.25, s4 = entropy < 7.0 ? 0.70 : entropy < 7.5 ? 0.50 : 0.25;
      aiScore += s4 * w4; totalWeight += w4;
      signals.push({ name: 'JPEG Entropy', value: `${entropy.toFixed(2)} bits/symbol`, flag: entropy < 7.2 ? 'uncertain' : 'human' });
    }
  } else if (isPng) {
    // PNG chunks
    let hasMeta = false;
    let pos = 8;
    while (pos + 8 < Math.min(buffer.length, 65536)) {
      const len = buffer.readUInt32BE(pos);
      const type = buffer.slice(pos+4, pos+8).toString('ascii');
      if (['tEXt','iTXt','zTXt'].includes(type)) hasMeta = true;
      if (type === 'IDAT' || type === 'IEND') break;
      pos += 12 + len;
    }
    const w2 = 0.35, s2 = foundSW ? 0.95 : 0.22;
    aiScore += s2 * w2; totalWeight += w2;
    signals.push({ name: 'PNG Software Tag', value: foundSW ? `AI tool detected: "${foundSW}"` : 'No AI signature', flag: foundSW ? 'ai' : 'human' });
    const w3 = 0.25, s3 = !hasMeta ? 0.60 : 0.25;
    aiScore += s3 * w3; totalWeight += w3;
    signals.push({ name: 'PNG Metadata Chunks', value: !hasMeta ? 'No text chunks (AI-like)' : 'Metadata found (real image)', flag: !hasMeta ? 'uncertain' : 'human' });
    const w4 = 0.30, s4 = foundSW ? 0.90 : 0.35;
    aiScore += s4 * w4; totalWeight += w4;
    signals.push({ name: 'Generation Metadata', value: foundSW ? `Prompt/metadata detected: "${foundSW}"` : 'No generation parameters found', flag: foundSW ? 'ai' : 'uncertain' });
  } else {
    const w2 = 0.60, s2 = foundSW ? 0.90 : 0.40;
    aiScore += s2 * w2; totalWeight += w2;
    signals.push({ name: 'Software Tag', value: foundSW ? `AI tool detected: "${foundSW}"` : 'No AI signature in file headers', flag: foundSW ? 'ai' : 'uncertain' });
  }

  return { score: totalWeight > 0 ? aiScore / totalWeight : 0.5, signals };
}

// ─── TEXT ENDPOINT ───────────────────────────────────────────────────────────
app.post('/api/analyze-text', async (req, res) => {
  const { text } = req.body;
  if (!text || text.trim().length < 20)
    return res.status(400).json({ error: 'Text must be at least 20 characters.' });

  try {
    const { score: heuristicScore, signals } = analyzeTextHeuristics(text);

    // Blend with Sapling AI if key is configured (Sapling is weighted 60%, heuristics 40%)
    const saplingScore = await callSaplingAI(text);
    const score = saplingScore !== null
      ? saplingScore * 0.60 + heuristicScore * 0.40
      : heuristicScore;

    if (saplingScore !== null) {
      signals.unshift({ name: 'Sapling AI Engine', value: `${Math.round(saplingScore * 100)}% AI probability`, flag: saplingScore > 0.6 ? 'ai' : saplingScore > 0.4 ? 'uncertain' : 'human' });
    }

    const detectionResult = {
      aiProbability: Math.round(score * 100),
      humanProbability: Math.round((1 - score) * 100),
      verdict: score > 0.68 ? 'AI-Generated' : score > 0.42 ? 'Uncertain' : 'Human-Written',
      confidence: score > 0.82 || score < 0.18 ? 'High' : score > 0.62 || score < 0.35 ? 'Medium' : 'Low',
      signals,
      engine: saplingScore !== null ? 'Sapling AI + Heuristics' : 'Heuristic Engine'
    };

    let sources = [];
    try {
      const snippet = text.slice(0, 120).replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      const serpRes = await axios.get('https://serpapi.com/search', {
        params: { q: `"${snippet}"`, api_key: SERP_API_KEY, num: 5, engine: 'google' },
        timeout: 15000
      });
      const organic = serpRes.data.organic_results || [];
      sources = organic.slice(0, 5).map(r => ({
        title: r.title, url: r.link, snippet: r.snippet, displayUrl: r.displayed_link || r.link
      }));
    } catch (e) { console.error('SerpAPI:', e.message); }

    res.json({ detection: detectionResult, sources, type: 'text' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Analysis failed. Please try again.' });
  }
});

// ─── IMAGE ENDPOINT ──────────────────────────────────────────────────────────
app.post('/api/analyze-image', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });

  const filePath = req.file.path;
  try {
    const imageBuffer = fs.readFileSync(filePath);
    const { score, signals } = analyzeImageHeuristics(imageBuffer, req.file.mimetype);

    const detectionResult = {
      aiProbability: Math.round(score * 100),
      humanProbability: Math.round((1 - score) * 100),
      verdict: score > 0.68 ? 'AI-Generated' : score > 0.42 ? 'Uncertain' : 'Real Image',
      confidence: score > 0.80 || score < 0.20 ? 'High' : score > 0.60 || score < 0.38 ? 'Medium' : 'Low',
      signals
    };

    // Reverse image search via SerpAPI (Google Lens)
    let sources = [];
    try {
      const serpRes = await axios.get('https://serpapi.com/search', {
        params: { engine: 'google_lens', url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png', api_key: SERP_API_KEY },
        timeout: 15000
      });
      const results = serpRes.data.visual_matches || serpRes.data.image_results || serpRes.data.organic_results || [];
      sources = results.slice(0, 5).map(r => ({
        title: r.title, url: r.link || r.source,
        snippet: r.snippet || r.source || '',
        displayUrl: r.displayed_link || r.link || r.source,
        thumbnail: r.thumbnail
      }));
    } catch (e) { console.error('SerpAPI reverse image:', e.message); }

    fs.unlinkSync(filePath);
    res.json({ detection: detectionResult, sources, type: 'image' });
  } catch (err) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    console.error(err);
    res.status(500).json({ error: 'Image analysis failed. Please try again.' });
  }
});

// ─── Serve frontend ───────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 AuthVerifier.ai running at http://localhost:${PORT}\n`);
});
