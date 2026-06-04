import axios from 'axios';

// ─── Microsoft Forms: Utilidades de URL ──────────────────────────────────────

/**
 * Detecta si una URL es de Microsoft Forms.
 */
export function isMicrosoftFormsUrl(url) {
  return /forms\.(office|microsoft)\.com/i.test(url);
}

/**
 * Resuelve URLs cortas de Microsoft Forms y normaliza el formato.
 * Soporta:
 * - https://forms.office.com/r/SHORTCODE
 * - https://forms.office.com/e/SHORTCODE
 * - https://forms.office.com/Pages/ResponsePage.aspx?id=FORM_ID
 * - https://forms.microsoft.com/...
 */
export async function resolveMicrosoftUrl(url) {
  // Si ya es una URL completa de ResponsePage, devolver tal cual
  if (url.includes('ResponsePage.aspx') || url.includes('DesignPage.aspx')) {
    return url;
  }

  // Para URLs cortas (/r/ o /e/), seguir redirects
  try {
    const response = await axios.get(url, {
      maxRedirects: 10,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    // La URL final después de redirects
    const finalUrl = response.request?.res?.responseUrl || response.config?.url || url;
    return finalUrl;
  } catch (err) {
    // Si falla el GET, intentar con HEAD
    try {
      const headResp = await axios.head(url, {
        maxRedirects: 10,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      return headResp.request?.res?.responseUrl || url;
    } catch {
      return url;
    }
  }
}

/**
 * Extrae el form ID de una URL de Microsoft Forms.
 * El ID puede estar en el query parameter `id` o en la ruta.
 */
function extractMsFormId(url) {
  // Formato: ?id=FORM_ID
  const idMatch = url.match(/[?&]id=([^&]+)/i);
  if (idMatch) return decodeURIComponent(idMatch[1]);

  // Formato: /r/SHORTCODE o /e/SHORTCODE
  const shortMatch = url.match(/\/(?:r|e)\/([a-zA-Z0-9]+)/);
  if (shortMatch) return shortMatch[1];

  return null;
}

// ─── Microsoft Forms: Mapeo de tipos ─────────────────────────────────────────

const MS_TYPE_MAP = {
  'Question.Choice': (q) => {
    // Choice puede ser radio o checkbox según allowMultiSelect
    if (q.allowMultiSelect) return 'checkbox';
    if (q.choiceType === 'Dropdown') return 'dropdown';
    return 'radio';
  },
  'Question.TextField': (q) => {
    if (q.multiline) return 'paragraph';
    return 'text';
  },
  'Question.Rating': () => 'scale',
  'Question.DateTime': () => 'date',
  'Question.Ranking': () => 'dropdown',
  'Question.Likert': () => 'grid',
  'Question.NPS': () => 'scale',
  'Question.MatrixChoice': () => 'grid',
  'Question.Net Promoter Score': () => 'scale',
};

/**
 * Convierte un tipo de pregunta de Microsoft Forms a nuestro tipo interno.
 */
function mapMsQuestionType(msQuestion) {
  const mapper = MS_TYPE_MAP[msQuestion.type];
  if (mapper) return mapper(msQuestion);
  return 'unknown';
}

// ─── Microsoft Forms: Extracción de datos del HTML ───────────────────────────

/**
 * Extrae el __RequestVerificationToken del HTML.
 */
function extractAntiForgeryToken(html) {
  // Patrón 1: input hidden
  const inputMatch = html.match(/<input[^>]*name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  if (inputMatch) return inputMatch[1];

  // Patrón 2: meta tag
  const metaMatch = html.match(/<meta[^>]*name="__RequestVerificationToken"[^>]*content="([^"]+)"/);
  if (metaMatch) return metaMatch[1];

  // Patrón 3: en un script como variable
  const scriptMatch = html.match(/requestVerificationToken['"]\s*:\s*['"]([^'"]+)['"]/);
  if (scriptMatch) return scriptMatch[1];

  return null;
}

/**
 * Extrae la información del formulario desde el HTML de Microsoft Forms.
 * Microsoft Forms embebe los datos del formulario de varias maneras.
 */
function extractFormDataFromHtml(html) {
  // ── Estrategia 1: Buscar JSON en script tags con datos del formulario ──
  // Microsoft Forms suele embeber los datos en un objeto JSON grande
  const patterns = [
    // Patrón: var defined = {...}
    /var\s+(?:defined|formData|__formData)\s*=\s*(\{[\s\S]*?\});/,
    // Patrón: window.__INITIAL_STATE__ = {...}
    /window\.__(?:INITIAL_STATE|FORM_DATA|NEXT_DATA)__\s*=\s*(\{[\s\S]*?\});/,
    // Patrón: data-form-data='...'
    /data-form-data=['"]([\s\S]*?)['"]/,
    // Patrón: ServerSideProps o initialData con questions
    /"questions"\s*:\s*(\[[\s\S]*?\])\s*[,}]/,
    // Patrón: formInfo con title y questions
    /"formInfo"\s*:\s*(\{[\s\S]*?"questions"[\s\S]*?\})\s*[,}]/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      try {
        const data = JSON.parse(match[1]);
        return data;
      } catch {
        // Intentar con el siguiente patrón
        continue;
      }
    }
  }

  // ── Estrategia 2: Buscar el JSON completo del formulario entre tags script ──
  const scriptTags = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const scriptTag of scriptTags) {
    const content = scriptTag.replace(/<\/?script[^>]*>/gi, '');
    // Buscar objetos JSON con propiedades de formulario
    const jsonPatterns = [
      /"title"\s*:.*?"questions"\s*:/,
      /"formId"\s*:.*?"title"\s*:/,
    ];

    for (const jp of jsonPatterns) {
      if (jp.test(content)) {
        // Intentar extraer el JSON más grande posible
        const jsonMatch = content.match(/(\{[\s\S]*\})/);
        if (jsonMatch) {
          try {
            const data = JSON.parse(jsonMatch[1]);
            if (data.questions || data.formInfo?.questions) {
              return data;
            }
          } catch {
            continue;
          }
        }
      }
    }
  }

  return null;
}

/**
 * Extrae las URLs del API de formulario desde el HTML.
 */
function extractApiUrls(html, pageUrl) {
  const result = {};

  // Buscar la base URL del API
  const apiBasePatterns = [
    /["']FormRenderApiBaseUrl["']\s*[:=]\s*["']([^"']+)["']/,
    /["']apiBaseUrl["']\s*[:=]\s*["']([^"']+)["']/,
    /formapi\/api\/[a-f0-9-]+\/users\/[a-f0-9-]+\/forms/,
  ];

  for (const pattern of apiBasePatterns) {
    const match = html.match(pattern);
    if (match) {
      result.apiBase = match[1] || match[0];
      break;
    }
  }

  // Buscar IDs del tenant y usuario
  const tenantMatch = html.match(/["']tenantId["']\s*[:=]\s*["']([a-f0-9-]+)["']/i);
  if (tenantMatch) result.tenantId = tenantMatch[1];

  const userMatch = html.match(/["']userId["']\s*[:=]\s*["']([a-f0-9-]+)["']/i);
  if (userMatch) result.userId = userMatch[1];

  // Buscar form ID
  const formIdMatch = html.match(/["']formId["']\s*[:=]\s*["']([^"']+)["']/i);
  if (formIdMatch) result.formId = formIdMatch[1];

  // Extraer la ruta completa del API de form desde la URL del formulario
  const fullApiMatch = html.match(/(\/formapi\/api\/[a-f0-9-]+\/users\/[a-f0-9-]+\/forms\(['"][^'"]+['"]\))/i);
  if (fullApiMatch) {
    result.apiPath = fullApiMatch[1];
  }

  // Construir base URL del sitio
  try {
    const urlObj = new URL(pageUrl);
    result.siteBase = `${urlObj.protocol}//${urlObj.hostname}`;
  } catch {
    result.siteBase = 'https://forms.office.com';
  }

  return result;
}

// ─── Microsoft Forms: Parseo de preguntas ────────────────────────────────────

/**
 * Parsea las preguntas desde los datos del formulario Microsoft.
 */
function parseMsQuestions(formData) {
  const questions = [];
  let rawQuestions = null;

  // Buscar las preguntas en distintas ubicaciones del objeto
  if (Array.isArray(formData.questions)) {
    rawQuestions = formData.questions;
  } else if (formData.formInfo?.questions) {
    rawQuestions = formData.formInfo.questions;
  } else if (formData.form?.questions) {
    rawQuestions = formData.form.questions;
  }

  if (!rawQuestions || !Array.isArray(rawQuestions)) return questions;

  // 1. Identificar todos los grupos parentales (MatrixChoiceGroup)
  const groups = new Map();
  for (const q of rawQuestions) {
    if (q.type === 'Question.MatrixChoiceGroup') {
      const groupOptions = [];
      if (q.choices && Array.isArray(q.choices)) {
        for (const choice of q.choices) {
          const val = choice.displayText || choice.description || choice.value || choice.text || (typeof choice === 'string' ? choice : '');
          if (val) {
            groupOptions.push({
              value: val,
              id: choice.id,
              key: choice.key
            });
          }
        }
      }
      groups.set(q.id, {
        title: q.title || q.questionText || 'Sin título',
        required: q.required || q.isRequired || false,
        options: groupOptions,
        rows: [],
      });
    }
  }

  // 2. Agrupar las filas individuales (MatrixChoice) bajo su respectivo grupo
  for (const q of rawQuestions) {
    if (q.type === 'Question.MatrixChoice') {
      const g = groups.get(q.groupId);
      if (g) {
        g.rows.push(q);
      }
    }
  }

  // 3. Ordenar filas de cada grupo ascendentemente según su propiedad "order"
  for (const group of groups.values()) {
    group.rows.sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  // 4. Procesar y parsear las preguntas finales
  for (const q of rawQuestions) {
    const type = mapMsQuestionType(q);

    // Omitir el grupo padre en sí mismo, ya que no es respondible directamente
    if (q.type === 'Question.MatrixChoiceGroup') {
      continue;
    }

    // Si es una fila de Grid/Likert (MatrixChoice)
    if (q.type === 'Question.MatrixChoice') {
      const group = groups.get(q.groupId);
      if (!group) continue;

      const rowIndex = group.rows.findIndex(r => r.id === q.id);

      questions.push({
        id: q.id,
        entryKey: q.id,
        title: q.title || q.questionText || `Fila ${rowIndex + 1}`,
        description: q.subtitle || q.description || '',
        type: 'grid',
        rawType: q.type,
        options: group.options.map(opt => opt.value),
        required: q.required || q.isRequired || group.required || false,
        gridTitle: group.title,
        rowLabel: q.title || q.questionText || `Fila ${rowIndex + 1}`,
        columns: group.options.map(opt => opt.value),
        _rowIndex: rowIndex,
        _parentId: q.groupId,
        _choices: group.options,
      });
      continue;
    }

    // Preguntas normales (Choice, TextField, Rating, NPS, etc.)
    const options = [];
    if (q.choices && Array.isArray(q.choices)) {
      for (const choice of q.choices) {
        const val = choice.displayText || choice.description || choice.value || choice.text || (typeof choice === 'string' ? choice : '');
        if (val) options.push(val);
      }
    }

    // Para escala/rating
    if (type === 'scale' && options.length === 0 && q.ratingOptions) {
      const min = q.ratingOptions.min || 1;
      const max = q.ratingOptions.max || q.ratingOptions.count || 5;
      for (let i = min; i <= max; i++) {
        options.push(String(i));
      }
    }

    // Para NPS
    if (type === 'scale' && options.length === 0 && q.type === 'Question.NPS') {
      for (let i = 0; i <= 10; i++) {
        options.push(String(i));
      }
    }

    questions.push({
      id: q.id || q.questionId,
      entryKey: q.id || q.questionId,
      title: q.title || q.questionText || 'Sin título',
      description: q.subtitle || q.description || '',
      type,
      rawType: q.type,
      options,
      required: q.required || q.isRequired || false,
    });
  }

  return questions;
}

// ─── Microsoft Forms: Análisis completo ──────────────────────────────────────

/**
 * Analiza un formulario de Microsoft Forms.
 * Recibe una URL, la resuelve, obtiene el HTML, extrae la estructura.
 */
export async function analyzeMicrosoftForm(rawUrl) {
  const resolvedUrl = await resolveMicrosoftUrl(rawUrl.trim());

  // Obtener la página HTML
  let pageHtml;
  let pageCookies;
  try {
    const response = await axios.get(resolvedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      },
      maxRedirects: 10,
    });
    pageHtml = response.data;
    // Capturar cookies de la respuesta
    pageCookies = response.headers['set-cookie'] || [];
  } catch (err) {
    if (err.response?.status === 404) {
      throw { status: 404, message: 'Formulario de Microsoft no encontrado.' };
    }
    throw { status: 500, message: `Error al acceder al formulario de Microsoft: ${err.message}` };
  }

  // Extraer el anti-forgery token
  let antiForgeryToken = extractAntiForgeryToken(pageHtml);

  // Extraer prefetchFormUrl y otros datos desde OfficeFormServerInfo si existe
  let prefetchFormUrl = null;
  const matchInfo = pageHtml.match(/window\.OfficeFormServerInfo\s*=\s*(\{[\s\S]*?\});/);
  if (matchInfo) {
    try {
      const serverInfo = JSON.parse(matchInfo[1]);
      prefetchFormUrl = serverInfo.prefetchFormUrl;
      if (serverInfo.antiForgeryToken) {
        antiForgeryToken = serverInfo.antiForgeryToken;
      }
    } catch (e) {
      console.error('[Microsoft Forms] Error parsing OfficeFormServerInfo:', e.message);
    }
  }

  // Fallback regex en caso de que falle el parseo del JSON
  if (!prefetchFormUrl) {
    const matchUrl = pageHtml.match(/"prefetchFormUrl"\s*:\s*"([^"]+)"/);
    if (matchUrl) {
      prefetchFormUrl = matchUrl[1].replace(/\\u0027/g, "'");
    }
  }

  // Extraer las URLs del API antiguas como fallback
  const apiUrls = extractApiUrls(pageHtml, resolvedUrl);

  let formData = null;

  // Intentar obtener estructura desde el prefetchFormUrl dinámico
  if (prefetchFormUrl) {
    try {
      const apiResp = await axios.get(prefetchFormUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          ...(antiForgeryToken && { '__RequestVerificationToken': antiForgeryToken }),
        },
        timeout: 10000,
      });
      if (apiResp.data && (apiResp.data.questions || apiResp.data.title)) {
        formData = apiResp.data;
        console.log('[Microsoft Forms] Estructura obtenida exitosamente vía prefetchFormUrl.');
      }
    } catch (err) {
      console.warn('[Microsoft Forms] No se pudo obtener datos del prefetchFormUrl:', err.message);
    }
  }

  // Fallback 1: Extraer los datos del formulario del HTML
  if (!formData) {
    formData = extractFormDataFromHtml(pageHtml);
  }

  // Fallback 2: Si no encontramos datos en el HTML, intentar via API tradicional
  if (!formData && apiUrls.apiPath) {
    try {
      const apiUrl = `${apiUrls.siteBase}${apiUrls.apiPath}`;
      const apiResp = await axios.get(apiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          ...(antiForgeryToken && { '__RequestVerificationToken': antiForgeryToken }),
        },
        timeout: 10000,
      });
      formData = apiResp.data;
    } catch {
      // Continuar sin datos de API
    }
  }

  // Fallback 3: Si todavía no tenemos datos, intentar construir la URL del API manualmente
  if (!formData) {
    const formId = extractMsFormId(resolvedUrl);
    if (formId) {
      // Intentar endpoint simplificado para formularios anónimos
      const possibleEndpoints = [
        `${apiUrls.siteBase}/formapi/api/${formId}/users/forms('${formId}')`,
        `${apiUrls.siteBase}/formapi/api/forms('${formId}')`,
      ];

      for (const endpoint of possibleEndpoints) {
        try {
          const apiResp = await axios.get(endpoint, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'application/json',
              ...(antiForgeryToken && { '__RequestVerificationToken': antiForgeryToken }),
            },
            timeout: 10000,
          });
          if (apiResp.data?.questions || apiResp.data?.form) {
            formData = apiResp.data;
            break;
          }
        } catch {
          continue;
        }
      }
    }
  }

  if (!formData) {
    throw {
      status: 422,
      message: 'No se pudo extraer la estructura del formulario de Microsoft. Verifica que sea público ("Cualquiera con el enlace puede responder") y la URL sea correcta.',
    };
  }

  // Parsear preguntas
  const questions = parseMsQuestions(formData);
  if (questions.length === 0) {
    throw {
      status: 422,
      message: 'Se accedió al formulario pero no se encontraron preguntas. Puede que el formato haya cambiado o el formulario esté vacío.',
    };
  }

  // Construir título y descripción
  const title = formData.title || formData.formInfo?.title || formData.form?.title || 'Formulario de Microsoft';
  const description = formData.description || formData.formInfo?.description || formData.form?.description || '';

  // Construir la URL de envío
  let submitUrl = null;
  if (prefetchFormUrl) {
    const basePath = prefetchFormUrl.split('?')[0];
    submitUrl = `${basePath.replace('/light/runtimeForms(', '/forms(')}/responses`;
  } else if (apiUrls.apiPath) {
    submitUrl = `${apiUrls.siteBase}${apiUrls.apiPath}/responses`;
  } else if (apiUrls.formId) {
    submitUrl = `${apiUrls.siteBase}/formapi/api/${apiUrls.tenantId || ''}/users/${apiUrls.userId || ''}/forms('${apiUrls.formId}')/responses`;
  } else {
    const formId = extractMsFormId(resolvedUrl);
    if (formId) {
      submitUrl = `${apiUrls.siteBase}/formapi/api/forms('${formId}')/responses`;
    }
  }

  return {
    platform: 'microsoft',
    title,
    description,
    submitUrl,
    questionCount: questions.length,
    questions,
    // Datos adicionales necesarios para el envío
    _msFormData: {
      antiForgeryToken,
      cookies: pageCookies,
      formId: apiUrls.formId || extractMsFormId(resolvedUrl),
      resolvedUrl,
      apiUrls,
    },
  };
}

// ─── Microsoft Forms: Envío ──────────────────────────────────────────────────

/**
 * Construye el payload de respuesta para Microsoft Forms.
 * Microsoft espera un JSON con el campo `answers` como string JSON serializada.
 */
function buildMsAnswersPayload(questions, generateAnswerFn) {
  const answers = [];
  const sentValues = {};

  for (const q of questions) {
    if (q.mode === 'skip') continue;

    const answer = generateAnswerFn(q);
    if (answer === null) continue;

    const answerEntry = {
      questionId: q.entryKey || q.id, // Para grids y otros, usar su propio ID
    };

    if (q.type === 'grid' && q._choices) {
      // Buscar la opción seleccionada en los metadatos de choices para obtener { id, key }
      const matchedChoice = q._choices.find(c => c.value === answer);
      if (matchedChoice) {
        answerEntry.answer1 = {
          id: matchedChoice.id,
          key: matchedChoice.key
        };
      } else {
        answerEntry.answer1 = null;
      }
      sentValues[q.entryKey] = String(answer);
    } else if (q.type === 'scale' || q.rawType === 'Question.Rating' || q.rawType === 'Question.NPS') {
      // Enviar como número directo
      answerEntry.answer1 = Number(answer);
      sentValues[q.entryKey] = String(answer);
    } else if (Array.isArray(answer)) {
      // Checkbox: múltiples valores
      answerEntry.answer1 = answer.join(';');
      sentValues[q.entryKey] = answer.join(', ');
    } else {
      answerEntry.answer1 = String(answer);
      sentValues[q.entryKey] = String(answer);
    }

    answers.push(answerEntry);
  }

  return { answers, sentValues };
}

/**
 * Envía un formulario de Microsoft Forms individual.
 * @param {string} submitUrl - URL del API de envío
 * @param {Array} questions - Configuración de preguntas
 * @param {Function} generateAnswerFn - Función para generar respuestas
 * @param {Object} msFormData - Datos extra del formulario (token, cookies, etc.)
 * @returns {{ accepted: boolean, sentValues: Object, status: number }}
 */
export async function submitMicrosoftForm(submitUrl, questions, generateAnswerFn, msFormData) {
  const { answers, sentValues } = buildMsAnswersPayload(questions, generateAnswerFn);

  if (answers.length === 0) {
    return { accepted: false, sentValues: {}, status: 0, error: 'No hay respuestas para enviar.' };
  }

  const payload = {
    startDate: new Date().toISOString(),
    submitDate: new Date().toISOString(),
    answers: JSON.stringify(answers),
  };

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Origin': msFormData?.apiUrls?.siteBase || 'https://forms.office.com',
    'Referer': msFormData?.resolvedUrl || 'https://forms.office.com/',
  };

  // Agregar token anti-CSRF si está disponible
  if (msFormData?.antiForgeryToken) {
    headers['__RequestVerificationToken'] = msFormData.antiForgeryToken;
  }

  // Agregar cookies si están disponibles
  if (msFormData?.cookies && Array.isArray(msFormData.cookies)) {
    headers['Cookie'] = msFormData.cookies
      .map((c) => c.split(';')[0])
      .join('; ');
  }

  try {
    const response = await axios.post(submitUrl, payload, {
      headers,
      validateStatus: () => true,
      timeout: 15000,
    });

    // Microsoft Forms devuelve 200/201 cuando acepta, 4xx cuando rechaza
    const accepted = response.status >= 200 && response.status < 300;

    return {
      accepted,
      sentValues,
      status: response.status,
    };
  } catch (err) {
    return {
      accepted: false,
      sentValues,
      status: 0,
      error: err.message,
    };
  }
}

/**
 * Renueva el token anti-CSRF obteniendo una nueva copia de la página.
 * Útil para misiones largas donde el token puede expirar.
 */
export async function refreshMsToken(resolvedUrl) {
  try {
    const response = await axios.get(resolvedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      maxRedirects: 10,
    });
    const token = extractAntiForgeryToken(response.data);
    const cookies = response.headers['set-cookie'] || [];
    return { antiForgeryToken: token, cookies };
  } catch {
    return null;
  }
}
