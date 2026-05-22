import express from 'express';
import cors from 'cors';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

// ─── Resolución de __dirname para ESM y CJS ─────────────────────────────────
// En CJS (bundle de esbuild): __dirname está disponible nativamente
// En ESM (desarrollo): se calcula desde import.meta.url
const __currentDir = typeof __dirname !== 'undefined'
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Determinar ruta del frontend estático ───────────────────────────────────
// En modo pkg (ejecutable), los assets están junto al .exe en client-dist/
// En modo desarrollo, están en ../client/dist/
const isPkg = typeof process.pkg !== 'undefined';
const clientDistPath = isPkg
  ? path.join(path.dirname(process.execPath), 'client-dist')
  : path.join(__currentDir, '..', 'client', 'dist');

app.use(cors());
app.use(express.json());

// ─── Servir frontend estático ────────────────────────────────────────────────
app.use(express.static(clientDistPath));

// ─── Estado global de misiones ───────────────────────────────────────────────
const missions = new Map();

// ─── Utilidades ──────────────────────────────────────────────────────────────

/**
 * Extrae el formId de una URL de Google Forms.
 * Soporta formatos /forms/d/e/XXXXX y /forms/d/XXXXX
 */
function extractFormId(url) {
  const match = url.match(/\/forms\/d\/e?\/?([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Resuelve URLs cortas (forms.gle) siguiendo redirects.
 * Devuelve la URL final completa de docs.google.com.
 */
async function resolveUrl(url) {
  // Si ya es una URL de docs.google.com, devolverla tal cual
  if (url.includes('docs.google.com/forms')) return url;

  // Para forms.gle u otras URLs cortas, seguir redirects
  try {
    const response = await axios.get(url, {
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    // axios sigue redirects automáticamente; la URL final está en:
    const finalUrl = response.request?.res?.responseUrl || response.config?.url;
    return finalUrl || url;
  } catch {
    return url;
  }
}

/**
 * Determina la URL base correcta para envío.
 * Google Forms tiene dos formatos de URL:
 * - /forms/d/e/FORM_ID/viewform  (publicadas con /e/)
 * - /forms/d/FORM_ID/viewform    (sin /e/)
 */
function buildFormUrls(url) {
  const eMatch = url.match(/(https:\/\/docs\.google\.com\/forms\/d\/e\/[a-zA-Z0-9_-]+)/);
  if (eMatch) {
    return {
      viewUrl: `${eMatch[1]}/viewform`,
      submitUrl: `${eMatch[1]}/formResponse`,
    };
  }
  const dMatch = url.match(/(https:\/\/docs\.google\.com\/forms\/d\/[a-zA-Z0-9_-]+)/);
  if (dMatch) {
    return {
      viewUrl: `${dMatch[1]}/viewform`,
      submitUrl: `${dMatch[1]}/formResponse`,
    };
  }
  return null;
}

/**
 * Parsea la estructura interna del formulario desde FB_PUBLIC_LOAD_DATA_
 * Tipos de pregunta Google Forms:
 * 0 = Respuesta corta (text)
 * 1 = Párrafo (textarea)
 * 2 = Opción múltiple (radio)
 * 3 = Casillas de verificación (checkbox)
 * 4 = Desplegable (dropdown)
 * 5 = Escala lineal
 * 7 = Cuadrícula de opción múltiple
 * 9 = Fecha
 * 10 = Hora
 */
function parseFormData(fbData) {
  const questions = [];

  // fbData[1][1] contiene la lista de items del formulario
  const items = fbData?.[1]?.[1];
  if (!Array.isArray(items)) return questions;

  // Mapear tipo numérico a string legible
  const typeMap = {
    0: 'text',
    1: 'paragraph',
    2: 'radio',
    3: 'checkbox',
    4: 'dropdown',
    5: 'scale',
    7: 'grid',
    9: 'date',
    10: 'time',
  };

  for (const item of items) {
    // item[1] = título de la pregunta
    // item[2] = descripción (puede ser null)
    // item[3] = tipo de pregunta (número) — ¡está a nivel de ITEM, no de field!
    // item[4] = array de fields (campos de entrada con entry IDs y opciones)
    const title = item?.[1] || 'Sin título';
    const description = item?.[2] || '';
    const itemType = item?.[3]; // El tipo se extrae del item padre
    const fields = item?.[4];

    if (!Array.isArray(fields)) continue;

    for (const field of fields) {
      // field[0] = entry ID numérico
      // field[1] = array de opciones [[valor, null, null, null, 0], ...]
      // field[2] = flag de requerido (1 = requerido, 0 = opcional)
      const entryId = field?.[0];
      const options = [];

      if (Array.isArray(field?.[1])) {
        for (const opt of field[1]) {
          if (Array.isArray(opt) && opt[0] !== undefined && opt[0] !== null) {
            options.push(String(opt[0]));
          }
        }
      }

      const type = typeMap[itemType] || 'unknown';
      const required = field?.[2] === 1;

      questions.push({
        id: entryId,
        entryKey: `entry.${entryId}`,
        title,
        description,
        type,
        rawType: itemType,
        options,
        required,
      });
    }
  }

  return questions;
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

/**
 * POST /api/analyze
 * Recibe { url } y devuelve la estructura del formulario parseada.
 */
app.post('/api/analyze', async (req, res) => {
  try {
    const { url: rawUrl } = req.body;
    if (!rawUrl) return res.status(400).json({ error: 'URL requerida' });

    // Resolver URLs cortas (forms.gle, etc.)
    const resolvedUrl = await resolveUrl(rawUrl.trim());

    const urls = buildFormUrls(resolvedUrl);
    if (!urls) return res.status(400).json({ error: 'URL de Google Forms no válida. URL resuelta: ' + resolvedUrl });

    // Obtener el HTML del formulario
    const response = await axios.get(urls.viewUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      },
    });

    const html = response.data;

    // Extraer FB_PUBLIC_LOAD_DATA_ del HTML
    const match = html.match(/FB_PUBLIC_LOAD_DATA_\s*=\s*(.*?);\s*<\/script>/s);
    if (!match) {
      return res.status(422).json({
        error: 'No se pudo extraer la estructura del formulario. Verifica que sea público y la URL sea correcta.',
      });
    }

    let fbData;
    try {
      fbData = JSON.parse(match[1]);
    } catch {
      return res.status(422).json({ error: 'Error al parsear los datos del formulario.' });
    }

    const formTitle = fbData?.[1]?.[8] || fbData?.[3] || 'Formulario sin título';
    const formDescription = fbData?.[1]?.[0] || '';
    const questions = parseFormData(fbData);

    res.json({
      success: true,
      form: {
        title: formTitle,
        description: formDescription,
        submitUrl: urls.submitUrl,
        questionCount: questions.length,
        questions,
      },
    });
  } catch (err) {
    console.error('[Analyze Error]', err.message);
    if (err.response?.status === 404) {
      return res.status(404).json({ error: 'Formulario no encontrado.' });
    }
    res.status(500).json({ error: `Error al analizar el formulario: ${err.message}` });
  }
});

/**
 * POST /api/mission/start
 * Recibe la configuración completa y ejecuta el envío masivo en background.
 * Body: {
 *   submitUrl: string,
 *   totalSubmissions: number,
 *   delayMs: number,
 *   questions: [{ entryKey, type, mode, fixedValue, options: [{ value, weight }] }]
 * }
 */
app.post('/api/mission/start', (req, res) => {
  const { submitUrl, totalSubmissions, delayMs, questions } = req.body;

  if (!submitUrl || !questions || !totalSubmissions) {
    return res.status(400).json({ error: 'Configuración incompleta.' });
  }

  const missionId = `mission_${Date.now()}`;
  const state = {
    id: missionId,
    status: 'running',
    total: Math.min(totalSubmissions, 500), // Límite de seguridad
    completed: 0,
    rejected: 0, // Envíos que Google rechazó silenciosamente
    failed: 0,
    errors: [],
    distribution: {}, // Tracking de valores enviados por entryKey
    startedAt: new Date().toISOString(),
  };

  missions.set(missionId, state);
  res.json({ success: true, missionId });

  // Ejecutar la misión en background
  executeMission(state, submitUrl, delayMs || 2000, questions);
});

/**
 * GET /api/mission/:id
 * Devuelve el estado actual de una misión.
 */
app.get('/api/mission/:id', (req, res) => {
  const state = missions.get(req.params.id);
  if (!state) return res.status(404).json({ error: 'Misión no encontrada.' });
  res.json(state);
});

/**
 * POST /api/mission/:id/stop
 * Detiene una misión en curso.
 */
app.post('/api/mission/:id/stop', (req, res) => {
  const state = missions.get(req.params.id);
  if (!state) return res.status(404).json({ error: 'Misión no encontrada.' });
  state.status = 'stopped';
  res.json({ success: true, state });
});

// ─── Motor de Ejecución ─────────────────────────────────────────────────────

/**
 * Genera una respuesta para una pregunta según su configuración.
 */
function generateAnswer(questionConfig) {
  const { type, mode, fixedValue, options } = questionConfig;

  // Modo fijo: siempre devuelve el mismo valor
  if (mode === 'fixed' && fixedValue !== undefined) {
    return fixedValue;
  }

  // Modo skip: no incluir respuesta
  if (mode === 'skip') {
    return null;
  }

  // Para preguntas de texto libre
  if (type === 'text' || type === 'paragraph') {
    if (Array.isArray(options) && options.length > 0) {
      return weightedRandom(options);
    }
    return fixedValue || '';
  }

  // Para preguntas con opciones (radio, dropdown, checkbox, scale)
  if (!Array.isArray(options) || options.length === 0) {
    return fixedValue || '';
  }

  if (type === 'checkbox') {
    // Para checkbox, seleccionar una o varias opciones según pesos
    const selected = [];
    for (const opt of options) {
      // Cada opción tiene una probabilidad independiente basada en su peso
      const probability = (opt.weight || 0) / 100;
      if (Math.random() < probability) {
        selected.push(opt.value);
      }
    }
    // Si nada fue seleccionado pero hay al menos una opción con peso > 0, seleccionar la de mayor peso
    if (selected.length === 0) {
      const maxOpt = options.reduce((max, opt) => (opt.weight || 0) > (max.weight || 0) ? opt : max, options[0]);
      if ((maxOpt.weight || 0) > 0) selected.push(maxOpt.value);
    }
    return selected;
  }

  // Radio, dropdown, scale: selección única ponderada
  return weightedRandom(options);
}

/**
 * Selección aleatoria ponderada.
 * options: [{ value, weight }]
 */
function weightedRandom(options) {
  const totalWeight = options.reduce((sum, opt) => sum + (opt.weight || 0), 0);
  if (totalWeight === 0) {
    // Si todos los pesos son 0, seleccionar uno al azar
    return options[Math.floor(Math.random() * options.length)].value;
  }

  let random = Math.random() * totalWeight;
  for (const opt of options) {
    random -= (opt.weight || 0);
    if (random <= 0) return opt.value;
  }
  return options[options.length - 1].value;
}

/**
 * Ejecuta la misión: envía formularios hasta alcanzar el total de ACEPTADOS.
 * Valida la respuesta de Google y reintenta rechazados/fallidos automáticamente.
 * Límite de seguridad: máximo 3x intentos del total solicitado para evitar bucles infinitos.
 */
async function executeMission(state, submitUrl, delayMs, questions) {
  const maxAttempts = state.total * 3; // Límite de seguridad
  let attempts = 0;

  while (state.completed < state.total && state.status === 'running') {
    // Límite de seguridad contra bucles infinitos
    if (attempts >= maxAttempts) {
      state.errors.push({ index: attempts, error: `Límite de intentos alcanzado (${maxAttempts}). Solo ${state.completed}/${state.total} aceptados.` });
      break;
    }

    attempts++;

    try {
      // Construir el payload
      const params = new URLSearchParams();
      const sentValues = {}; // Rastrear qué se envía en esta iteración

      for (const q of questions) {
        if (q.mode === 'skip') continue;

        const answer = generateAnswer(q);

        if (answer === null) continue;

        if (Array.isArray(answer)) {
          for (const val of answer) {
            params.append(q.entryKey, val);
          }
          sentValues[q.entryKey] = answer.join(', ');
        } else {
          params.append(q.entryKey, String(answer));
          sentValues[q.entryKey] = String(answer);
        }
      }

      const response = await axios.post(submitUrl, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        validateStatus: () => true,
      });

      // Verificar si Google realmente aceptó el envío
      const html = response.data || '';
      const isAccepted = typeof html === 'string' && (
        html.includes('freebirdFormviewerViewResponseConfirmationMessage') ||
        html.includes('FormResponse') ||
        response.status === 200
      );

      if (isAccepted) {
        state.completed++;
        // Registrar distribución de valores enviados
        for (const [key, val] of Object.entries(sentValues)) {
          if (!state.distribution[key]) state.distribution[key] = {};
          state.distribution[key][val] = (state.distribution[key][val] || 0) + 1;
        }
      } else {
        state.rejected++;
        // No registrar cada rechazo individual para no saturar el array de errores
        if (state.rejected <= 5) {
          state.errors.push({ index: attempts, error: `Rechazo silencioso (status: ${response.status})` });
        }
      }
    } catch (err) {
      state.failed++;
      if (state.failed <= 5) {
        state.errors.push({ index: attempts, error: err.message });
      }
    }

    // Delay entre envíos (excepto si ya se completó)
    if (state.completed < state.total && state.status === 'running') {
      const jitter = delayMs * (0.7 + Math.random() * 0.6);
      await new Promise((resolve) => setTimeout(resolve, jitter));
    }
  }

  if (state.status === 'running') {
    state.status = 'completed';
  }
  state.attempts = attempts;
  state.finishedAt = new Date().toISOString();
  console.log(`[Mission ${state.id}] Completada: ${state.completed} aceptados, ${state.rejected} rechazados, ${state.failed} fallidos (${attempts} intentos totales)`);
  console.log(`[Mission ${state.id}] Distribución:`, JSON.stringify(state.distribution, null, 2));
}

// ─── Catch-all: SPA fallback ─────────────────────────────────────────────────
// Cualquier ruta que NO sea /api/* se redirige al index.html del frontend.
// Esto permite que React Router (si se usa) maneje las rutas del lado del cliente.
app.get('*', (req, res) => {
  const indexPath = path.join(clientDistPath, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.status(404).send('Frontend no encontrado. Ejecuta el build del cliente primero.');
    }
  });
});

// ─── Auto-apertura del navegador ─────────────────────────────────────────────
function openBrowser(url) {
  const platform = process.platform;
  let cmd;
  if (platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, (err) => {
    if (err) console.log('[Forms Automator] No se pudo abrir el navegador automáticamente.');
  });
}

// ─── Inicio del servidor ────────────────────────────────────────────────────
app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`[Forms Automator] Backend activo en ${url}`);
  console.log(`[Forms Automator] Sirviendo frontend desde: ${clientDistPath}`);
  // Abrir navegador automáticamente solo en modo portable (pkg)
  if (isPkg) {
    console.log('[Forms Automator] Abriendo navegador...');
    openBrowser(url);
  }
});
