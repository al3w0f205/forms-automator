import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ─── Resolución de rutas ─────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_DIR = path.join(__dirname, 'client');
const SERVER_DIR = path.join(__dirname, 'server');
const OUTPUT_DIR = path.join(__dirname, 'portable');
const SERVER_BUNDLE = path.join(OUTPUT_DIR, 'server-bundle.cjs');
const CLIENT_DIST_SRC = path.join(CLIENT_DIR, 'dist');
const CLIENT_DIST_DEST = path.join(OUTPUT_DIR, 'client-dist');

// ─── Utilidades ──────────────────────────────────────────────────────────────
function run(cmd, cwd = __dirname) {
  console.log(`\n  ▸ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function copyDirSync(src, dest) {
  if (!fs.existsSync(src)) {
    throw new Error(`Directorio fuente no existe: ${src}`);
  }
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true });
  }
  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Pipeline de Build
// ═════════════════════════════════════════════════════════════════════════════
console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║       Forms Automator — Build Portable (.exe)          ║');
console.log('╚══════════════════════════════════════════════════════════╝');

// ── Paso 1: Build del frontend ───────────────────────────────────────────────
console.log('\n[1/5] Construyendo frontend (React + Vite)...');
run('npm run build', CLIENT_DIR);

if (!fs.existsSync(path.join(CLIENT_DIST_SRC, 'index.html'))) {
  console.error('ERROR: El build del frontend no generó index.html');
  process.exit(1);
}
console.log('  ✓ Frontend compilado exitosamente');

// ── Paso 2: Crear directorio de salida ───────────────────────────────────────
console.log('\n[2/5] Preparando directorio de salida...');
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}
console.log(`  ✓ Directorio: ${OUTPUT_DIR}`);

// ── Paso 3: Bundlear servidor con esbuild (ESM → CJS) ───────────────────────
console.log('\n[3/5] Bundleando servidor (ESM → CJS con esbuild)...');
run(
  `npx -y esbuild "${path.join(SERVER_DIR, 'index.js')}" --bundle --platform=node --target=node20 --format=cjs --outfile="${SERVER_BUNDLE}" --external:child_process --external:node:sqlite --log-level=warning`,
  __dirname
);

if (!fs.existsSync(SERVER_BUNDLE)) {
  console.error('ERROR: esbuild no generó el bundle del servidor');
  process.exit(1);
}
console.log('  ✓ Servidor bundleado exitosamente');

// ── Paso 4: Empaquetar con pkg ──────────────────────────────────────────────
console.log('\n[4/5] Empaquetando ejecutable con pkg...');

// Crear package.json temporal para pkg con node:sqlite como externo
const pkgConfig = {
  name: 'forms-automator',
  version: '1.0.0',
  main: 'server-bundle.cjs',
  pkg: {
    targets: ['node20-win-x64'],
    outputPath: 'FormsAutomator.exe',
    external: ['node:sqlite'],
  },
};
const pkgConfigPath = path.join(OUTPUT_DIR, 'package.json');
fs.writeFileSync(pkgConfigPath, JSON.stringify(pkgConfig, null, 2));

run(
  `npx -y @yao-pkg/pkg "${SERVER_BUNDLE}" --config "${pkgConfigPath}" --targets node20-win-x64 --output "${path.join(OUTPUT_DIR, 'FormsAutomator.exe')}"`,
  __dirname
);

// Limpiar package.json temporal
if (fs.existsSync(pkgConfigPath)) {
  fs.unlinkSync(pkgConfigPath);
}

console.log('  ✓ Ejecutable generado');

// ── Paso 5: Copiar assets del frontend junto al .exe ─────────────────────────
console.log('\n[5/5] Copiando assets del frontend...');
copyDirSync(CLIENT_DIST_SRC, CLIENT_DIST_DEST);
console.log(`  ✓ Frontend copiado a: ${CLIENT_DIST_DEST}`);

// ── Limpieza del bundle temporal ─────────────────────────────────────────────
if (fs.existsSync(SERVER_BUNDLE)) {
  fs.unlinkSync(SERVER_BUNDLE);
  console.log('  ✓ Bundle temporal eliminado');
}

// ── Resumen final ────────────────────────────────────────────────────────────
console.log('\n╔══════════════════════════════════════════════════════════╗');
console.log('║              ✓ BUILD COMPLETADO                        ║');
console.log('╠══════════════════════════════════════════════════════════╣');
console.log(`║  Ejecutable: portable/FormsAutomator.exe                ║`);
console.log(`║  Frontend:   portable/client-dist/                      ║`);
console.log('╠══════════════════════════════════════════════════════════╣');
console.log('║  Copia la carpeta "portable/" completa a cualquier PC   ║');
console.log('║  y ejecuta FormsAutomator.exe (no requiere Node.js).    ║');
console.log('╚══════════════════════════════════════════════════════════╝');
