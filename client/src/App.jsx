import { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import './App.css';

const API = '/api';

// ─── Mapeo de tipos para badges ─────────────────────────────────────────────
const TYPE_LABELS = {
  radio: 'Opción múltiple',
  checkbox: 'Casillas',
  dropdown: 'Desplegable',
  text: 'Texto corto',
  paragraph: 'Párrafo',
  scale: 'Escala',
  grid: 'Cuadrícula',
  date: 'Fecha',
  time: 'Hora',
  unknown: 'Desconocido',
};

const HAS_OPTIONS = ['radio', 'checkbox', 'dropdown', 'scale'];
const HAS_TEXT = ['text', 'paragraph'];

// ─── Paleta de colores para opciones ─────────────────────────────────────────
const OPTION_COLORS = [
  '#6366f1', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b',
  '#f43f5e', '#ec4899', '#14b8a6', '#f97316', '#84cc16',
  '#a78bfa', '#22d3ee', '#34d399', '#fbbf24', '#fb7185',
];

// ═════════════════════════════════════════════════════════════════════════════
// Componente: QuestionConfigurator
// Renderiza la configuración de UNA pregunta (modo, pesos/valor fijo).
// ═════════════════════════════════════════════════════════════════════════════
function QuestionConfigurator({ question, config, onChange }) {
  const isOptionType = HAS_OPTIONS.includes(question.type);
  const isTextType = HAS_TEXT.includes(question.type);
  const isCheckbox = question.type === 'checkbox';

  const handleModeChange = (e) => {
    const mode = e.target.value;
    onChange({ ...config, mode });
  };

  // Cambio directo de peso (sin normalización — para checkbox)
  const handleWeightDirect = (index, weight) => {
    const val = Math.max(0, Math.min(100, Number(weight) || 0));
    const newOptions = config.options.map((o) => ({ ...o }));
    newOptions[index].weight = val;
    onChange({ ...config, options: newOptions });
  };

  // Cambio con auto-normalización (radio/dropdown/scale → suma = 100)
  const handleWeightNormalized = (index, weight) => {
    const val = Math.max(0, Math.min(100, Number(weight) || 0));
    const newOptions = config.options.map((o) => ({ ...o }));
    const oldWeight = newOptions[index].weight;
    newOptions[index].weight = val;

    const delta = val - oldWeight;
    const othersTotal = newOptions.reduce((s, o, i) => i !== index ? s + o.weight : s, 0);

    if (othersTotal > 0 && delta !== 0) {
      const scale = Math.max(0, othersTotal - delta) / othersTotal;
      let distributed = 0;
      newOptions.forEach((opt, i) => {
        if (i !== index) {
          opt.weight = Math.max(0, Math.round(opt.weight * scale));
          distributed += opt.weight;
        }
      });
      // Corregir redondeo: ajustar el primer "otro" para que sume exactamente 100
      const targetOthers = 100 - val;
      if (distributed !== targetOthers && newOptions.length > 1) {
        const firstOther = newOptions.findIndex((_, i) => i !== index);
        if (firstOther !== -1) {
          newOptions[firstOther].weight = Math.max(0, newOptions[firstOther].weight + (targetOthers - distributed));
        }
      }
    } else if (othersTotal === 0 && newOptions.length > 1) {
      // Todos los demás en 0: distribuir el restante equitativamente
      const remaining = Math.max(0, 100 - val);
      const perOther = Math.floor(remaining / (newOptions.length - 1));
      let given = 0;
      newOptions.forEach((opt, i) => {
        if (i !== index) {
          opt.weight = perOther;
          given += perOther;
        }
      });
      // Ajuste por redondeo
      const firstOther = newOptions.findIndex((_, i) => i !== index);
      if (firstOther !== -1 && given !== remaining) {
        newOptions[firstOther].weight += remaining - given;
      }
    }

    onChange({ ...config, options: newOptions });
  };

  // Presets de distribución
  const applyPreset = (type) => {
    const n = config.options.length;
    if (n === 0) return;
    const newOptions = config.options.map((o) => ({ ...o }));

    if (type === 'equal') {
      const base = Math.floor(100 / n);
      const remainder = 100 - base * n;
      newOptions.forEach((opt, i) => {
        opt.weight = base + (i < remainder ? 1 : 0);
      });
    } else if (type === 'first') {
      const dominant = 70;
      const rest = n > 1 ? Math.floor(30 / (n - 1)) : 0;
      const remainder = n > 1 ? 30 - rest * (n - 1) : 0;
      newOptions.forEach((opt, i) => {
        opt.weight = i === 0 ? dominant + remainder : rest;
      });
    } else if (type === 'last') {
      const dominant = 70;
      const rest = n > 1 ? Math.floor(30 / (n - 1)) : 0;
      const remainder = n > 1 ? 30 - rest * (n - 1) : 0;
      newOptions.forEach((opt, i) => {
        opt.weight = i === n - 1 ? dominant + remainder : rest;
      });
    } else if (type === 'reset') {
      newOptions.forEach((opt) => { opt.weight = 0; });
    }

    onChange({ ...config, options: newOptions });
  };

  const handleFixedChange = (e) => {
    onChange({ ...config, fixedValue: e.target.value });
  };

  // Cálculos derivados
  const totalWeight = config.options.reduce((s, o) => s + (o.weight || 0), 0);

  // Modos disponibles según tipo
  const modes = [];
  if (isOptionType) {
    modes.push({ value: 'weighted', label: 'Ponderado' });
    modes.push({ value: 'random', label: 'Aleatorio' });
    modes.push({ value: 'fixed', label: 'Fijo' });
  } else if (isTextType) {
    modes.push({ value: 'fixed', label: 'Fijo' });
    modes.push({ value: 'skip', label: 'Omitir' });
  } else {
    modes.push({ value: 'fixed', label: 'Fijo' });
    modes.push({ value: 'skip', label: 'Omitir' });
  }
  if (isOptionType && !question.required) {
    modes.push({ value: 'skip', label: 'Omitir' });
  }

  return (
    <div className="question-card">
      <div className="question-header">
        <div className="question-title-group">
          <div className="question-title">{question.title}</div>
          <div className="question-meta-row">
            <span className={`type-badge ${question.type}`}>
              {TYPE_LABELS[question.type] || question.type}
            </span>
            {question.required && (
              <span className="type-badge required">Requerida</span>
            )}
          </div>
        </div>
        <div className="mode-selector">
          <select value={config.mode} onChange={handleModeChange}>
            {modes.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Modo ponderado (mejorado) ── */}
      {isOptionType && config.mode === 'weighted' && (
        <div className="weight-config">
          {/* Presets + total */}
          <div className="weight-presets">
            <button className="preset-btn" onClick={() => applyPreset('equal')} title="Distribuir equitativamente">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="4" y1="21" x2="4" y2="14"/><line x1="12" y1="21" x2="12" y2="14"/><line x1="20" y1="21" x2="20" y2="14"/></svg>
              Igual
            </button>
            <button className="preset-btn" onClick={() => applyPreset('first')} title="Primera opción dominante (70%)">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="4" y1="21" x2="4" y2="4"/><line x1="12" y1="21" x2="12" y2="16"/><line x1="20" y1="21" x2="20" y2="16"/></svg>
              1° dom.
            </button>
            <button className="preset-btn" onClick={() => applyPreset('last')} title="Última opción dominante (70%)">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="4" y1="21" x2="4" y2="16"/><line x1="12" y1="21" x2="12" y2="16"/><line x1="20" y1="21" x2="20" y2="4"/></svg>
              Últ. dom.
            </button>
            <button className="preset-btn preset-btn-ghost" onClick={() => applyPreset('reset')} title="Resetear todos los pesos">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
              Reset
            </button>
            {!isCheckbox && (
              <span className={`weight-total ${totalWeight === 100 ? 'balanced' : totalWeight > 100 ? 'over' : 'under'}`}>
                Σ {totalWeight}%
              </span>
            )}
          </div>

          {/* Barra de distribución visual */}
          {!isCheckbox && totalWeight > 0 && (
            <div className="distribution-bar">
              {config.options.map((opt, i) => {
                const pct = (opt.weight / totalWeight) * 100;
                return pct > 0 ? (
                  <div
                    key={i}
                    className="distribution-segment"
                    style={{
                      width: `${pct}%`,
                      backgroundColor: OPTION_COLORS[i % OPTION_COLORS.length],
                    }}
                    title={`${opt.value}: ${Math.round(pct)}%`}
                  />
                ) : null;
              })}
            </div>
          )}

          {/* Opciones con pesos */}
          <div className="options-weights">
            {config.options.map((opt, i) => (
              <div className="option-weight-row" key={i}>
                <span
                  className="option-color-dot"
                  style={{ backgroundColor: OPTION_COLORS[i % OPTION_COLORS.length] }}
                />
                <span className="option-label" title={opt.value}>{opt.value}</span>
                <div className="option-bar-track">
                  <div
                    className="option-bar-fill"
                    style={{
                      width: `${Math.min(100, opt.weight)}%`,
                      backgroundColor: OPTION_COLORS[i % OPTION_COLORS.length],
                    }}
                  />
                </div>
                <input
                  type="number"
                  className="option-weight-input"
                  min="0"
                  max="100"
                  value={opt.weight}
                  onChange={(e) => {
                    const val = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                    isCheckbox ? handleWeightDirect(i, val) : handleWeightNormalized(i, val);
                  }}
                />
                <span className="option-weight-unit">%</span>
              </div>
            ))}
          </div>

          {/* Hint para checkbox */}
          {isCheckbox && (
            <div className="weight-hint">
              Cada porcentaje es la probabilidad independiente de seleccionar esa opción.
            </div>
          )}
        </div>
      )}

      {/* Valor fijo para opciones */}
      {isOptionType && config.mode === 'fixed' && (
        <select
          className="fixed-input"
          value={config.fixedValue || ''}
          onChange={handleFixedChange}
        >
          <option value="">— Seleccionar opción —</option>
          {question.options.map((opt, i) => (
            <option key={i} value={opt}>{opt}</option>
          ))}
        </select>
      )}

      {/* Input de texto para tipos texto */}
      {isTextType && config.mode === 'fixed' && (
        <input
          type="text"
          className="fixed-input"
          placeholder="Escribir respuesta fija..."
          value={config.fixedValue || ''}
          onChange={handleFixedChange}
        />
      )}

      {/* Modo aleatorio: igual probabilidad */}
      {isOptionType && config.mode === 'random' && (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.4rem' }}>
          Cada opción tiene la misma probabilidad de ser seleccionada.
        </div>
      )}

      {/* Modo skip */}
      {config.mode === 'skip' && (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.4rem' }}>
          Esta pregunta no será respondida.
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Componente: ProgressMonitor
// Muestra el progreso de la misión activa.
// ═════════════════════════════════════════════════════════════════════════════
function ProgressMonitor({ missionId, onComplete }) {
  const [state, setState] = useState(null);
  const intervalRef = useRef(null);

  useEffect(() => {
    if (!missionId) return;

    const poll = async () => {
      try {
        const { data } = await axios.get(`${API}/mission/${missionId}`);
        setState(data);
        if (data.status !== 'running') {
          clearInterval(intervalRef.current);
          if (onComplete) onComplete(data);
        }
      } catch {
        // Silenciar errores de polling
      }
    };

    poll();
    intervalRef.current = setInterval(poll, 1000);

    return () => clearInterval(intervalRef.current);
  }, [missionId, onComplete]);

  if (!state) return null;

  const percent = state.total > 0
    ? Math.round((state.completed / state.total) * 100)
    : 0;

  return (
    <div className="progress-section">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
        <span className={`status-badge ${state.status}`}>
          {state.status === 'running' && <span className="pulse" />}
          {state.status === 'running' ? 'Enviando...' : state.status === 'completed' ? 'Completado' : 'Detenido'}
        </span>
        <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--accent-indigo)', fontVariantNumeric: 'tabular-nums' }}>
          {percent}%
        </span>
      </div>
      <div className="progress-bar-container">
        <div className="progress-bar-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="progress-stats">
        <div className="progress-stat">
          <span className="label">Aceptados:</span>
          <span className="value success">{state.completed}/{state.total}</span>
        </div>
        {(state.rejected || 0) > 0 && (
          <div className="progress-stat">
            <span className="label">Reintentados:</span>
            <span className="value fail">{state.rejected}</span>
          </div>
        )}
        {state.failed > 0 && (
          <div className="progress-stat">
            <span className="label">Fallidos:</span>
            <span className="value fail">{state.failed}</span>
          </div>
        )}
        {state.attempts && state.attempts > state.total && (
          <div className="progress-stat">
            <span className="label">Intentos:</span>
            <span className="value total">{state.attempts}</span>
          </div>
        )}
      </div>

      {/* Distribución de valores enviados */}
      {state.distribution && Object.keys(state.distribution).length > 0 && state.status !== 'running' && (
        <div style={{ marginTop: '1rem', padding: '0.75rem', background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
            Distribución real de envíos
          </div>
          {Object.entries(state.distribution).map(([entryKey, values]) => (
            <div key={entryKey} style={{ marginBottom: '0.5rem' }}>
              {Object.entries(values).map(([val, count]) => {
                const pct = state.completed > 0 ? ((count / state.completed) * 100).toFixed(1) : 0;
                return (
                  <div key={val} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', minWidth: '80px' }}>{val}</span>
                    <div style={{ flex: 1, height: '4px', background: 'rgba(99,102,241,0.1)', borderRadius: '2px', overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: 'var(--gradient-primary)', borderRadius: '2px' }} />
                    </div>
                    <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-indigo)', minWidth: '60px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {count} ({pct}%)
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Componente Principal: App
// ═════════════════════════════════════════════════════════════════════════════
function App() {
  // ── Estado ──
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState(null);              // Datos del formulario analizado
  const [configs, setConfigs] = useState([]);            // Configuración por pregunta
  const [totalSubmissions, setTotalSubmissions] = useState(50);
  const [delayMs, setDelayMs] = useState(2000);
  const [missionId, setMissionId] = useState(null);
  const [missionActive, setMissionActive] = useState(false);

  // ── Analizar formulario ──
  const handleAnalyze = async () => {
    setError('');
    setForm(null);
    setConfigs([]);
    setMissionId(null);
    setMissionActive(false);

    if (!url.trim()) {
      setError('Ingresa una URL de Google Forms.');
      return;
    }

    setLoading(true);
    try {
      const { data } = await axios.post(`${API}/analyze`, { url: url.trim() });
      if (!data.success) {
        setError(data.error || 'Error desconocido.');
        return;
      }

      setForm(data.form);

      // Generar configuración por defecto para cada pregunta
      const defaultConfigs = data.form.questions.map((q) => {
        const isOptionType = HAS_OPTIONS.includes(q.type);
        const isTextType = HAS_TEXT.includes(q.type);

        if (isOptionType) {
          // Distribuir peso equitativo por defecto
          const equalWeight = q.options.length > 0
            ? Math.floor(100 / q.options.length)
            : 0;
          return {
            entryKey: q.entryKey,
            type: q.type,
            mode: 'weighted',
            fixedValue: q.options[0] || '',
            options: q.options.map((val) => ({ value: val, weight: equalWeight })),
          };
        }

        if (isTextType) {
          return {
            entryKey: q.entryKey,
            type: q.type,
            mode: 'fixed',
            fixedValue: '',
            options: [],
          };
        }

        // Otros tipos: fijo por defecto
        return {
          entryKey: q.entryKey,
          type: q.type,
          mode: 'skip',
          fixedValue: '',
          options: [],
        };
      });

      setConfigs(defaultConfigs);
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  // ── Actualizar config de una pregunta ──
  const updateConfig = useCallback((index, newConfig) => {
    setConfigs((prev) => {
      const next = [...prev];
      next[index] = newConfig;
      return next;
    });
  }, []);

  // ── Iniciar misión ──
  const handleStartMission = async () => {
    if (!form) return;
    setError('');

    // Validar que preguntas requeridas no estén en skip
    for (let i = 0; i < form.questions.length; i++) {
      const q = form.questions[i];
      const c = configs[i];
      if (q.required && c.mode === 'skip') {
        setError(`La pregunta "${q.title}" es requerida y no puede omitirse.`);
        return;
      }
      if (c.mode === 'fixed' && HAS_TEXT.includes(q.type) && !c.fixedValue) {
        setError(`La pregunta "${q.title}" requiere un valor fijo.`);
        return;
      }
    }

    // Preparar configs para envío: en modo random, asignar pesos iguales
    const questionsPayload = configs.map((c) => {
      if (c.mode === 'random') {
        const equalWeight = c.options.length > 0 ? 100 / c.options.length : 0;
        return {
          ...c,
          options: c.options.map((o) => ({ ...o, weight: equalWeight })),
        };
      }
      return c;
    });

    try {
      const { data } = await axios.post(`${API}/mission/start`, {
        submitUrl: form.submitUrl,
        totalSubmissions: Number(totalSubmissions),
        delayMs: Number(delayMs),
        questions: questionsPayload,
      });

      if (data.success) {
        setMissionId(data.missionId);
        setMissionActive(true);
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  // ── Detener misión ──
  const handleStopMission = async () => {
    if (!missionId) return;
    try {
      await axios.post(`${API}/mission/${missionId}/stop`);
    } catch {
      // Silenciar
    }
  };

  // ── Callback cuando la misión termina ──
  const handleMissionComplete = useCallback(() => {
    setMissionActive(false);
  }, []);

  // ── Tecla Enter en URL ──
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !loading) handleAnalyze();
  };

  return (
    <div className="app-container">
      {/* ── Header ── */}
      <header className="app-header">
        <h1>Forms Automator</h1>
        <p>Analiza, configura y ejecuta envíos automáticos</p>
      </header>

      {/* ── URL Input ── */}
      <div className="card">
        <div className="card-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          Analizar Formulario
        </div>
        <div className="url-input-group">
          <input
            id="url-input"
            type="url"
            placeholder="https://docs.google.com/forms/d/e/..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
          />
          <button
            id="btn-analyze"
            className="btn btn-primary"
            onClick={handleAnalyze}
            disabled={loading}
          >
            {loading ? <span className="spinner" /> : null}
            {loading ? 'Analizando...' : 'Analizar'}
          </button>
        </div>
      </div>

      {/* ── Error ── */}
      {error && (
        <div className="alert error" style={{ marginTop: '1rem' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
          {error}
        </div>
      )}

      {/* ── Formulario Analizado ── */}
      {form && (
        <>
          {/* Header del formulario */}
          <div className="card" style={{ marginTop: '1rem' }}>
            <div className="form-header">
              <div className="form-header-info">
                <h2>{form.title}</h2>
                {form.description && <p>{form.description}</p>}
              </div>
              <div className="form-meta">
                <span className="meta-badge">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14,2 14,8 20,8"/></svg>
                  {form.questionCount} preguntas
                </span>
              </div>
            </div>

            {/* Lista de preguntas configurables */}
            <div className="question-list">
              {form.questions.map((q, i) => (
                <QuestionConfigurator
                  key={q.id}
                  question={q}
                  config={configs[i]}
                  onChange={(newConfig) => updateConfig(i, newConfig)}
                />
              ))}
            </div>
          </div>

          {/* Controles de misión */}
          <div className="card" style={{ marginTop: '1rem' }}>
            <div className="card-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
              Ejecución
            </div>
            <div className="mission-controls">
              <div className="mission-field">
                <label htmlFor="total-submissions">Cantidad</label>
                <input
                  id="total-submissions"
                  type="number"
                  min="1"
                  max="500"
                  value={totalSubmissions}
                  onChange={(e) => setTotalSubmissions(e.target.value)}
                  disabled={missionActive}
                />
              </div>
              <div className="mission-field">
                <label htmlFor="delay-ms">Intervalo (ms)</label>
                <input
                  id="delay-ms"
                  type="number"
                  min="500"
                  max="30000"
                  step="500"
                  value={delayMs}
                  onChange={(e) => setDelayMs(e.target.value)}
                  disabled={missionActive}
                />
              </div>
              <div className="mission-actions">
                {!missionActive ? (
                  <button
                    id="btn-start"
                    className="btn btn-primary"
                    onClick={handleStartMission}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
                    Iniciar Misión
                  </button>
                ) : (
                  <button
                    id="btn-stop"
                    className="btn btn-danger"
                    onClick={handleStopMission}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
                    Detener
                  </button>
                )}
              </div>
            </div>

            {/* Monitor de progreso */}
            {missionId && (
              <ProgressMonitor
                missionId={missionId}
                onComplete={handleMissionComplete}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default App;
