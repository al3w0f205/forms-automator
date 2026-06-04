import axios from 'axios';

// ─── Google Forms: Utilidades de URL ─────────────────────────────────────────

/**
 * Resuelve URLs cortas (forms.gle) siguiendo redirects.
 * Devuelve la URL final completa de docs.google.com.
 */
export async function resolveGoogleUrl(url) {
  if (url.includes('docs.google.com/forms')) return url;

  try {
    const response = await axios.get(url, {
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const finalUrl = response.request?.res?.responseUrl || response.config?.url;
    return finalUrl || url;
  } catch {
    return url;
  }
}

/**
 * Determina la URL base correcta para envío de Google Forms.
 * Soporta formatos con /e/ y sin /e/.
 */
export function buildGoogleFormUrls(url) {
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

// ─── Google Forms: Parseo de estructura ──────────────────────────────────────

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
  const items = fbData?.[1]?.[1];
  if (!Array.isArray(items)) return questions;

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
    const title = item?.[1] || 'Sin título';
    const description = item?.[2] || '';
    const itemType = item?.[3];
    const fields = item?.[4];

    if (!Array.isArray(fields)) continue;

    for (let fi = 0; fi < fields.length; fi++) {
      const field = fields[fi];
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

      const questionData = {
        id: entryId,
        entryKey: `entry.${entryId}`,
        title,
        description,
        type,
        rawType: itemType,
        options,
        required,
      };

      if (itemType === 7) {
        questionData.gridTitle = title;
        questionData.rowLabel = field?.[3]?.[0] || `Fila ${fi + 1}`;
        questionData.columns = options;
        questionData.title = field?.[3]?.[0] || `Fila ${fi + 1}`;
      }

      questions.push(questionData);
    }
  }

  return questions;
}

// ─── Google Forms: Análisis completo ─────────────────────────────────────────

/**
 * Analiza un formulario de Google Forms.
 * Recibe una URL (puede ser corta), la resuelve, obtiene el HTML,
 * extrae FB_PUBLIC_LOAD_DATA_ y parsea la estructura.
 */
export async function analyzeGoogleForm(rawUrl) {
  const resolvedUrl = await resolveGoogleUrl(rawUrl.trim());

  const urls = buildGoogleFormUrls(resolvedUrl);
  if (!urls) {
    throw { status: 400, message: 'URL de Google Forms no válida. URL resuelta: ' + resolvedUrl };
  }

  const response = await axios.get(urls.viewUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    },
  });

  const html = response.data;

  const match = html.match(/FB_PUBLIC_LOAD_DATA_\s*=\s*(.*?);\s*<\/script>/s);
  if (!match) {
    throw {
      status: 422,
      message: 'No se pudo extraer la estructura del formulario. Verifica que sea público y la URL sea correcta.',
    };
  }

  let fbData;
  try {
    fbData = JSON.parse(match[1]);
  } catch {
    throw { status: 422, message: 'Error al parsear los datos del formulario.' };
  }

  const formTitle = fbData?.[1]?.[8] || fbData?.[3] || 'Formulario sin título';
  const formDescription = fbData?.[1]?.[0] || '';
  const questions = parseFormData(fbData);

  return {
    platform: 'google',
    title: formTitle,
    description: formDescription,
    submitUrl: urls.submitUrl,
    questionCount: questions.length,
    questions,
  };
}

// ─── Google Forms: Envío ─────────────────────────────────────────────────────

/**
 * Verifica si Google realmente aceptó el envío.
 */
function isSubmissionAccepted(response) {
  const html = response.data;
  if (typeof html !== 'string') return false;

  if (html.includes('freebirdFormviewerViewResponseConfirmationMessage')) {
    return true;
  }

  if (html.includes('freebirdFormviewerViewItemsItemErrorMessage') ||
      html.includes('freebirdFormviewerViewNavigationPasswordError') ||
      html.includes('freebirdFormviewerViewResponseErrorMessage')) {
    return false;
  }

  if (response.status === 200 && html.length > 0) {
    return true;
  }

  return false;
}

/**
 * Envía un formulario de Google Forms individual.
 * @param {string} submitUrl - URL de envío (/formResponse)
 * @param {Array} questions - Configuración de preguntas con respuestas generadas
 * @param {Function} generateAnswerFn - Función para generar respuestas
 * @returns {{ accepted: boolean, sentValues: Object, status: number }}
 */
export async function submitGoogleForm(submitUrl, questions, generateAnswerFn) {
  const params = new URLSearchParams();
  const sentValues = {};

  for (const q of questions) {
    if (q.mode === 'skip') continue;

    const answer = generateAnswerFn(q);
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
    timeout: 15000,
  });

  return {
    accepted: isSubmissionAccepted(response),
    sentValues,
    status: response.status,
  };
}
