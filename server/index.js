import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

// ─── Módulos de plataformas ──────────────────────────────────────────────────
import { analyzeGoogleForm, submitGoogleForm } from './googleForms.js';
import {
  isMicrosoftFormsUrl,
  analyzeMicrosoftForm,
  submitMicrosoftForm,
  refreshMsToken,
} from './microsoftForms.js';

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

// ─── Detección de plataforma ─────────────────────────────────────────────────

/**
 * Detecta si una URL es de Google Forms o Microsoft Forms.
 * @returns {'google' | 'microsoft' | null}
 */
function detectPlatform(url) {
  if (!url) return null;
  const lower = url.toLowerCase();

  // Google Forms
  if (lower.includes('docs.google.com/forms') ||
      lower.includes('forms.gle/')) {
    return 'google';
  }

  // Microsoft Forms
  if (isMicrosoftFormsUrl(url)) {
    return 'microsoft';
  }

  return null;
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

/**
 * POST /api/analyze
 * Recibe { url } y devuelve la estructura del formulario parseada.
 * Detecta automáticamente si es Google Forms o Microsoft Forms.
 */
app.post('/api/analyze', async (req, res) => {
  try {
    const { url: rawUrl } = req.body;
    if (!rawUrl) return res.status(400).json({ error: 'URL requerida' });

    const platform = detectPlatform(rawUrl.trim());

    if (!platform) {
      return res.status(400).json({
        error: 'URL no reconocida. Ingresa una URL válida de Google Forms (docs.google.com/forms/...) o Microsoft Forms (forms.office.com/...).',
      });
    }

    let formData;
    if (platform === 'google') {
      formData = await analyzeGoogleForm(rawUrl);
    } else {
      formData = await analyzeMicrosoftForm(rawUrl);
    }

    res.json({
      success: true,
      form: formData,
    });
  } catch (err) {
    console.error('[Analyze Error]', err.message || err);

    // Errores lanzados por los módulos con status
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }

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
 *   platform: 'google' | 'microsoft',
 *   totalSubmissions: number,
 *   delayMs: number,
 *   questions: [{ entryKey, type, mode, fixedValue, options: [{ value, weight }] }],
 *   msFormData?: Object  // Solo para Microsoft Forms
 * }
 */
app.post('/api/mission/start', (req, res) => {
  const { submitUrl, platform, totalSubmissions, delayMs, questions, msFormData } = req.body;

  if (!submitUrl || !questions || !totalSubmissions) {
    return res.status(400).json({ error: 'Configuración incompleta.' });
  }

  const missionId = `mission_${Date.now()}`;
  const state = {
    id: missionId,
    status: 'running',
    total: Math.min(totalSubmissions, 500), // Límite de seguridad
    completed: 0,
    rejected: 0, // Envíos que el servidor rechazó
    failed: 0,
    errors: [],
    distribution: {}, // Tracking de valores enviados por entryKey
    startedAt: new Date().toISOString(),
    platform: platform || 'google',
  };

  missions.set(missionId, state);
  res.json({ success: true, missionId });

  // Ejecutar la misión en background
  executeMission(state, submitUrl, delayMs || 2000, questions, platform || 'google', msFormData);
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

  // Para preguntas con opciones (radio, dropdown, checkbox, scale, grid)
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

  // Radio, dropdown, scale, grid: selección única ponderada
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
 * Calcula el nivel de concurrencia según el delay configurado.
 * Con delays altos se envía 1 a la vez (parece más humano).
 * Con delays bajos se envían varios en paralelo (máximo rendimiento).
 */
function getConcurrency(delayMs) {
  if (delayMs >= 3000) return 1;
  if (delayMs >= 1500) return 2;
  if (delayMs >= 1000) return 3;
  if (delayMs >= 500) return 5;
  return 10; // Máximo: 10 concurrent
}

/**
 * Ejecuta la misión: envía formularios con concurrencia adaptativa.
 * Reintenta rechazados/fallidos automáticamente.
 * Límite de seguridad: máximo 3x intentos del total solicitado.
 */
async function executeMission(state, submitUrl, delayMs, questions, platform, msFormData) {
  const maxAttempts = state.total * 3;
  let attempts = 0;
  const concurrency = getConcurrency(delayMs);

  // Para Microsoft Forms, refrescar token periódicamente
  let currentMsData = msFormData ? { ...msFormData } : null;
  let lastTokenRefresh = Date.now();
  const TOKEN_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutos

  console.log(`[Mission ${state.id}] Iniciando: ${state.total} envíos, platform=${platform}, delay=${delayMs}ms, concurrencia=${concurrency}`);

  while (state.completed < state.total && state.status === 'running') {
    if (attempts >= maxAttempts) {
      state.errors.push({
        index: attempts,
        error: `Límite de intentos alcanzado (${maxAttempts}). Solo ${state.completed}/${state.total} aceptados.`,
      });
      break;
    }

    // Refrescar token de Microsoft si ha pasado suficiente tiempo
    if (platform === 'microsoft' && currentMsData && (Date.now() - lastTokenRefresh) > TOKEN_REFRESH_INTERVAL) {
      try {
        const refreshed = await refreshMsToken(currentMsData.resolvedUrl);
        if (refreshed) {
          currentMsData.antiForgeryToken = refreshed.antiForgeryToken || currentMsData.antiForgeryToken;
          currentMsData.cookies = refreshed.cookies || currentMsData.cookies;
          lastTokenRefresh = Date.now();
          console.log(`[Mission ${state.id}] Token de Microsoft refrescado.`);
        }
      } catch {
        // Continuar con el token actual
      }
    }

    // Calcular cuántos envíos lanzar en este batch
    const remaining = state.total - state.completed;
    const batchSize = Math.min(concurrency, remaining, maxAttempts - attempts);

    // Lanzar batch de envíos concurrentes
    const batchPromises = [];
    for (let b = 0; b < batchSize; b++) {
      attempts++;

      let submitPromise;
      if (platform === 'microsoft') {
        submitPromise = submitMicrosoftForm(submitUrl, questions, generateAnswer, currentMsData)
          .catch((err) => ({
            accepted: false,
            error: err.message,
            sentValues: {},
            status: 0,
          }));
      } else {
        submitPromise = submitGoogleForm(submitUrl, questions, generateAnswer)
          .catch((err) => ({
            accepted: false,
            error: err.message,
            sentValues: {},
            status: 0,
          }));
      }

      batchPromises.push(submitPromise);
    }

    // Esperar resultados del batch
    const results = await Promise.all(batchPromises);

    for (const result of results) {
      if (state.status !== 'running') break;

      if (result.error) {
        // Error de red/timeout
        state.failed++;
        if (state.failed <= 5) {
          state.errors.push({ index: attempts, error: result.error });
        }
      } else if (result.accepted) {
        state.completed++;
        // Registrar distribución de valores enviados
        for (const [key, val] of Object.entries(result.sentValues)) {
          if (!state.distribution[key]) state.distribution[key] = {};
          state.distribution[key][val] = (state.distribution[key][val] || 0) + 1;
        }
      } else {
        state.rejected++;
        if (state.rejected <= 5) {
          let errorMsg = `Rechazado por el servidor (status: ${result.status})`;
          if (result.status === 401) {
            errorMsg = platform === 'microsoft'
              ? `Rechazado (status: 401 - El formulario requiere iniciar sesión con cuenta Microsoft)`
              : `Rechazado (status: 401 - El formulario requiere iniciar sesión / Limitar a 1 respuesta)`;
          } else if (result.status === 403) {
            errorMsg = `Rechazado (status: 403 - Acceso denegado. El formulario puede requerir autenticación o estar protegido contra bots)`;
          }
          state.errors.push({ index: attempts, error: errorMsg });
        }
      }
    }

    // Delay entre batches (excepto si ya se completó)
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
app.use((req, res, next) => {
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
if (process.env.NODE_ENV !== 'test') {
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
}

export default app;
